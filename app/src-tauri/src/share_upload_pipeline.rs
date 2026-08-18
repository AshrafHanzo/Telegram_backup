//! Overlaps a share upload's two legs: browser → this machine, and this
//! machine → Telegram.
//!
//! Chunked upload staged the whole file first and only then sent it on, so the
//! browser hit 100% and the user then waited out a second transfer of the same
//! length with no indication anything was happening — a wait proportional to
//! file size (~35s for 113MB, ~20min for 4GB).
//!
//! Here the Telegram upload starts as soon as the first chunk lands and is fed
//! each chunk as it arrives, so both legs run at once. The remaining wait is
//! the time to send the *last* chunk rather than the whole file, which makes it
//! roughly constant instead of proportional.
//!
//! Two properties are deliberately preserved:
//!
//! - **The staging file is still written first, and is still the source of
//!   truth for progress.** The browser's resume behaviour is untouched, so the
//!   dropped-connection handling this was built for still works exactly as
//!   before.
//! - **The sequential path remains the fallback.** If the Telegram leg fails
//!   for any reason, the caller finishes the old way from the completed staging
//!   file. A slower upload is a much better failure than a lost one.

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, ReadBuf};
use tokio::sync::{mpsc, Mutex, Notify};

/// Bytes of already-received-but-not-yet-sent data allowed to queue up. When
/// Telegram is the slower leg this fills, and the chunk handler then waits on
/// it — which is the point: it bounds memory and paces the uploader to the
/// speed the file can actually be forwarded at, instead of buffering the whole
/// transfer in RAM.
const PIPELINE_CAPACITY_BYTES: u64 = 48 * 1024 * 1024;

/// One in-flight pipelined upload.
pub struct PipelinedUpload {
    pub total_size: u64,
    /// Bytes handed to Telegram. This is what a progress bar should show:
    /// unlike bytes received, reaching the total here means the transfer is
    /// genuinely finished rather than half done.
    sent: Arc<AtomicU64>,
    /// Bytes pushed into the channel so far. A chunk that is retried (or that
    /// previously landed only partly before the connection dropped) overlaps
    /// what was already forwarded, and the overlap has to be dropped — the
    /// channel is a stream with no way to rewrite history.
    pushed: AtomicU64,
    /// Set once the Telegram side has given up, so the chunk handler stops
    /// feeding a pipeline nothing is draining.
    failed: AtomicBool,
    sender: Mutex<Option<mpsc::Sender<io::Result<bytes::Bytes>>>>,
    outcome: Mutex<Option<Result<i32, String>>>,
    finished: Notify,
}

impl PipelinedUpload {
    /// Bytes forwarded to Telegram so far.
    pub fn sent_bytes(&self) -> u64 {
        self.sent.load(Ordering::Relaxed)
    }

    pub fn has_failed(&self) -> bool {
        self.failed.load(Ordering::Relaxed)
    }

    pub fn mark_failed(&self) {
        self.failed.store(true, Ordering::Relaxed);
    }

    /// Forwards the part of `chunk` that hasn't already been sent.
    ///
    /// `offset` is where this chunk starts in the file. Anything before
    /// `pushed` has already gone to Telegram, so only the tail beyond it is
    /// forwarded; a fully duplicate chunk forwards nothing. Returns `false` if
    /// the pipeline can no longer be used and the caller should fall back.
    pub async fn feed(&self, offset: u64, chunk: &[u8]) -> bool {
        if self.has_failed() {
            return false;
        }
        let pushed = self.pushed.load(Ordering::Relaxed);
        // A gap would mean forwarding bytes out of order, which cannot be
        // repaired mid-stream — refuse rather than corrupt the upload.
        if offset > pushed {
            self.mark_failed();
            return false;
        }
        let skip = (pushed - offset) as usize;
        if skip >= chunk.len() {
            return true; // wholly duplicate: already forwarded, nothing to do
        }
        let fresh = &chunk[skip..];

        let sender = {
            let guard = self.sender.lock().await;
            match guard.as_ref() {
                Some(sender) => sender.clone(),
                None => return false,
            }
        };
        if sender
            .send(Ok(bytes::Bytes::copy_from_slice(fresh)))
            .await
            .is_err()
        {
            // The consumer is gone, which means the Telegram side ended early.
            self.mark_failed();
            return false;
        }
        self.pushed
            .fetch_add(fresh.len() as u64, Ordering::Relaxed);
        true
    }

    /// Closes the channel so the reader sees EOF. Must be called once every
    /// byte has been fed, or `upload_stream` waits forever for a file it has
    /// been told the length of.
    pub async fn finish_feeding(&self) {
        self.sender.lock().await.take();
    }

    /// Waits for the Telegram side to finish and returns the message id.
    pub async fn wait_for_outcome(&self) -> Result<i32, String> {
        loop {
            // Register interest before checking, so an outcome stored between
            // the check and the wait can't be missed.
            let notified = self.finished.notified();
            if let Some(outcome) = self.outcome.lock().await.clone() {
                return outcome;
            }
            notified.await;
        }
    }

    pub async fn store_outcome(&self, outcome: Result<i32, String>) {
        if outcome.is_err() {
            self.mark_failed();
        }
        *self.outcome.lock().await = Some(outcome);
        self.finished.notify_waiters();
    }
}

/// In-flight uploads, so the chunk requests that follow the first one find the
/// job it started. Keyed by upload id, which is already validated as 32 hex
/// characters before it reaches here.
static ACTIVE: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, Arc<PipelinedUpload>>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

pub fn lookup(upload_id: &str) -> Option<Arc<PipelinedUpload>> {
    ACTIVE
        .lock()
        .ok()
        .and_then(|guard| guard.get(upload_id).cloned())
}

/// Registers a new job, returning `false` if one already exists — which means a
/// concurrent request won the race and its job should be used instead.
pub fn register(upload_id: &str, upload: Arc<PipelinedUpload>) -> bool {
    match ACTIVE.lock() {
        Ok(mut guard) => {
            if guard.contains_key(upload_id) {
                return false;
            }
            guard.insert(upload_id.to_string(), upload);
            true
        }
        Err(_) => false,
    }
}

pub fn forget(upload_id: &str) {
    if let Ok(mut guard) = ACTIVE.lock() {
        guard.remove(upload_id);
    }
}

/// Creates a pipelined upload plus the reader its Telegram side consumes.
///
/// The reader is handed straight to the existing `stream_*_to_telegram`
/// helpers, which already take any `AsyncRead` — so the upload path that was
/// verified working is reused rather than reimplemented.
pub fn create(
    total_size: u64,
) -> (
    Arc<PipelinedUpload>,
    impl AsyncRead + Unpin + Send + 'static,
) {
    // Sized in whole 8MB chunks so one queued chunk can't be split across
    // slots and stall a sender holding a partial write.
    let slots = ((PIPELINE_CAPACITY_BYTES / (8 * 1024 * 1024)).max(2)) as usize;
    let (sender, receiver) = mpsc::channel::<io::Result<bytes::Bytes>>(slots);
    let sent = Arc::new(AtomicU64::new(0));

    let upload = Arc::new(PipelinedUpload {
        total_size,
        sent: sent.clone(),
        pushed: AtomicU64::new(0),
        failed: AtomicBool::new(false),
        sender: Mutex::new(Some(sender)),
        outcome: Mutex::new(None),
        finished: Notify::new(),
    });

    let reader = ChannelReader {
        receiver,
        pending: bytes::Bytes::new(),
        counter: sent,
    };
    (upload, reader)
}

/// Presents the fed chunks as one continuous reader, and counts bytes as they
/// are pulled — which is what progress is measured from: bytes `upload_stream`
/// has actually taken and is sending, not bytes merely received from the
/// browser.
struct ChannelReader {
    receiver: mpsc::Receiver<io::Result<bytes::Bytes>>,
    /// Remainder of the last chunk received, when it was larger than the read
    /// buffer it was being copied into.
    pending: bytes::Bytes,
    counter: Arc<AtomicU64>,
}

impl AsyncRead for ChannelReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if buf.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        // Loop rather than return early on an empty chunk: filling nothing
        // would be read as end-of-file and truncate the upload.
        while self.pending.is_empty() {
            match self.receiver.poll_recv(cx) {
                Poll::Ready(Some(Ok(chunk))) => self.pending = chunk,
                Poll::Ready(Some(Err(error))) => return Poll::Ready(Err(error)),
                // Sender dropped: every byte has been fed.
                Poll::Ready(None) => return Poll::Ready(Ok(())),
                Poll::Pending => return Poll::Pending,
            }
        }
        let take = std::cmp::min(buf.remaining(), self.pending.len());
        buf.put_slice(&self.pending[..take]);
        self.pending = self.pending.slice(take..);
        self.counter.fetch_add(take as u64, Ordering::Relaxed);
        Poll::Ready(Ok(()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn forwarded_bytes_arrive_in_order_and_are_counted() {
        let (upload, mut reader) = create(6);
        assert!(upload.feed(0, b"abc").await);
        assert!(upload.feed(3, b"def").await);
        upload.finish_feeding().await;

        let mut out = Vec::new();
        reader.read_to_end(&mut out).await.unwrap();
        assert_eq!(out, b"abcdef");
        assert_eq!(upload.sent_bytes(), 6);
    }

    #[tokio::test]
    async fn a_fully_duplicate_chunk_forwards_nothing() {
        // What a retry of an already-applied chunk looks like. Forwarding it
        // again would duplicate bytes in the file Telegram receives.
        let (upload, mut reader) = create(3);
        assert!(upload.feed(0, b"abc").await);
        assert!(upload.feed(0, b"abc").await);
        upload.finish_feeding().await;

        let mut out = Vec::new();
        reader.read_to_end(&mut out).await.unwrap();
        assert_eq!(out, b"abc");
    }

    #[tokio::test]
    async fn a_partly_applied_chunk_forwards_only_its_new_tail() {
        // The mid-transfer drop case: 2 of 5 bytes landed, then the client
        // resends the whole chunk from its own offset.
        let (upload, mut reader) = create(5);
        assert!(upload.feed(0, b"ab").await);
        assert!(upload.feed(0, b"abcde").await);
        upload.finish_feeding().await;

        let mut out = Vec::new();
        reader.read_to_end(&mut out).await.unwrap();
        assert_eq!(out, b"abcde", "overlap should be dropped, not duplicated");
        assert_eq!(upload.sent_bytes(), 5);
    }

    #[tokio::test]
    async fn a_gap_fails_the_pipeline_instead_of_corrupting_it() {
        let (upload, _reader) = create(100);
        assert!(upload.feed(0, b"abc").await);
        // Skipping ahead cannot be represented in a stream, so this must not
        // silently produce a file with a hole in it.
        assert!(!upload.feed(50, b"xyz").await);
        assert!(upload.has_failed());
    }

    #[tokio::test]
    async fn feeding_stops_once_the_pipeline_has_failed() {
        let (upload, _reader) = create(10);
        upload.mark_failed();
        assert!(!upload.feed(0, b"abc").await);
        assert_eq!(upload.sent_bytes(), 0);
    }

    #[tokio::test]
    async fn an_outcome_stored_before_the_wait_is_still_seen() {
        // Guards the ordering bug this is easy to write: if the waiter checked
        // after registering interest it would hang on an already-finished job.
        let (upload, _reader) = create(1);
        upload.store_outcome(Ok(42)).await;
        assert_eq!(upload.wait_for_outcome().await, Ok(42));
    }

    #[tokio::test]
    async fn a_failed_outcome_marks_the_upload_failed() {
        let (upload, _reader) = create(1);
        upload.store_outcome(Err("nope".to_string())).await;
        assert!(upload.has_failed());
        assert!(upload.wait_for_outcome().await.is_err());
    }

    #[tokio::test]
    async fn a_waiter_is_woken_when_the_outcome_lands_later() {
        let (upload, _reader) = create(1);
        let waiter = upload.clone();
        let handle = tokio::spawn(async move { waiter.wait_for_outcome().await });
        // Give the waiter a chance to park before the outcome is stored.
        tokio::task::yield_now().await;
        upload.store_outcome(Ok(7)).await;
        assert_eq!(handle.await.unwrap(), Ok(7));
    }
}
