//! Automatic large-file splitting for uploads over Telegram's single-message
//! size limit (`crypto::policy::TELEGRAM_MAX_FILE_SIZE`, 2GB).
//!
//! A file larger than that limit is uploaded as N ordinary document
//! messages ("parts", each tagged with `SPLIT_PART_MARKER` in its caption so
//! `cmd_get_files`/`extract_search_files` hide them from the normal file
//! view) plus one plain TEXT message ("the manifest", tagged with
//! `SPLIT_MANIFEST_MARKER`) sent only once every part has already landed
//! successfully. The manifest carries the original name/size and the
//! ordered list of part message ids — it's what `cmd_get_files` renders as
//! the single logical file the user actually sees, and what
//! `cmd_download_file`/`cmd_rename_file`/`cmd_delete_file` resolve back into
//! their constituent parts.
//!
//! The manifest is deliberately a plain message (not a caption on an
//! attached document, unlike the audit-log/catalog/jobs markers elsewhere in
//! this codebase): a plain message's text has a much larger length budget
//! than a caption on media, which matters once `part_ids` grows for very
//! large files, and it lets renaming stay a one-line `EditMessage` text edit
//! instead of needing to reconstruct and re-attach media.
//!
//! Known v1 limitations, accepted deliberately: split files never appear in
//! `cmd_search_global` (Telegram's `SearchGlobal` can only return messages
//! with an attached document, and the manifest structurally has none), and
//! they can't be moved between folders (see `cmd_move_files`). Uploading
//! and downloading a split file through a "Generate Temp Link" share IS
//! supported, including HTTP Range requests for resumable downloads (see
//! `folder_share_routes.rs`).
//!
//! Both upload and download retry a failed attempt (a whole part for
//! uploads, an individual chunk — and across separate attempts, a resumed
//! byte range — for downloads) rather than restarting the entire logical
//! transfer from scratch, since grammers gives no way to resume an upload
//! mid-part (its `file_id` is generated and consumed internally). See
//! `commands::fs::upload_with_retry`/`open_download_file_for_resume` and
//! `folder_share_routes::upload_stream_with_retry`.

use crate::crypto::policy::TELEGRAM_MAX_FILE_SIZE;
use grammers_client::types::Peer;
use grammers_client::Client;
use serde::{Deserialize, Serialize};

pub(crate) const SPLIT_MANIFEST_MARKER: &str = "[TD-SPLIT]";
pub(crate) const SPLIT_PART_MARKER: &str = "[TD-SPLIT-PART]";

/// Maximum ids per `get_messages_by_id`/`forward_messages` call — grammers
/// documents both as capped at 100 per request.
const MAX_IDS_PER_BATCH: usize = 100;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct SplitManifest {
    pub schema_version: u16,
    pub name: String,
    pub size: u64,
    pub part_count: u32,
    pub part_ids: Vec<i32>,
}

/// Parses a message's text as a split-file manifest, if it is one. Returns
/// `None` for any non-matching or malformed text — never panics, since this
/// runs against arbitrary messages (including ones from other apps/users
/// that happen to share this folder).
pub(crate) fn parse_manifest(text: &str) -> Option<SplitManifest> {
    let json = text.strip_prefix(SPLIT_MANIFEST_MARKER)?;
    serde_json::from_str(json).ok()
}

pub(crate) fn is_split_part(text: &str) -> bool {
    text.starts_with(SPLIT_PART_MARKER)
}

pub(crate) fn should_split(size: u64) -> bool {
    size > TELEGRAM_MAX_FILE_SIZE
}

/// Splits `total_size` into consecutive `(start, len)` byte ranges, each at
/// most `TELEGRAM_MAX_FILE_SIZE`. Pure and easy to unit test in isolation
/// from any actual I/O or Telegram call.
pub(crate) fn part_ranges(total_size: u64) -> Vec<(u64, u64)> {
    if total_size == 0 {
        return vec![(0, 0)];
    }
    let mut ranges = Vec::new();
    let mut offset = 0u64;
    while offset < total_size {
        let len = std::cmp::min(TELEGRAM_MAX_FILE_SIZE, total_size - offset);
        ranges.push((offset, len));
        offset += len;
    }
    ranges
}

/// Maps an absolute byte offset into the logical file to `(part_index,
/// offset_within_part)`, given the same `ranges` `part_ranges` produced for
/// that file. Used by both download-resume (desktop app) and HTTP Range
/// support (Temp Link) to figure out which part a resume/range point falls
/// in, without re-deriving the boundary arithmetic twice.
///
/// `byte_offset` is assumed to be `< total_size` (i.e. a valid resume/range
/// start, never a full-file-consumed offset) — callers are expected to have
/// already handled the "nothing left to send" case before calling this.
pub(crate) fn locate_offset(ranges: &[(u64, u64)], byte_offset: u64) -> (usize, u64) {
    let mut consumed = 0u64;
    for (index, (_, len)) in ranges.iter().enumerate() {
        if byte_offset < consumed + len {
            return (index, byte_offset - consumed);
        }
        consumed += len;
    }
    // Past the end of every range — clamp to the start of one past the last
    // part rather than panicking, so a caller with an off-by-one still gets
    // a sane (if unused) answer instead of an index-out-of-bounds.
    (ranges.len(), 0)
}

/// Human-readable (cosmetic only — code never parses this back out) part
/// caption for anyone browsing raw Telegram directly.
pub(crate) fn part_caption(index: usize, total: usize, original_name: &str) -> String {
    format!("{} {}/{} \u{2013} {}", SPLIT_PART_MARKER, index + 1, total, original_name)
}

pub(crate) fn manifest_text(manifest: &SplitManifest) -> Result<String, String> {
    let json = serde_json::to_string(manifest).map_err(|e| e.to_string())?;
    Ok(format!("{}{}", SPLIT_MANIFEST_MARKER, json))
}

/// Fetches messages by id in batches of at most `MAX_IDS_PER_BATCH`,
/// preserving the input order in the flattened output. Any id that doesn't
/// resolve to a message becomes a `None` in the result at that position, so
/// callers can tell exactly which id (if any) is missing.
pub(crate) async fn fetch_messages_chunked(
    client: &Client,
    peer: &Peer,
    ids: &[i32],
) -> Result<Vec<Option<grammers_client::types::Message>>, String> {
    let mut out = Vec::with_capacity(ids.len());
    for batch in ids.chunks(MAX_IDS_PER_BATCH) {
        let messages = client
            .get_messages_by_id(peer, batch)
            .await
            .map_err(|e| format!("Failed to fetch messages: {}", e))?;
        out.extend(messages);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_ranges_splits_into_expected_chunks() {
        let ranges = part_ranges(TELEGRAM_MAX_FILE_SIZE * 2 + 500);
        assert_eq!(ranges, vec![
            (0, TELEGRAM_MAX_FILE_SIZE),
            (TELEGRAM_MAX_FILE_SIZE, TELEGRAM_MAX_FILE_SIZE),
            (TELEGRAM_MAX_FILE_SIZE * 2, 500),
        ]);
    }

    #[test]
    fn part_ranges_exact_multiple_has_no_trailing_empty_range() {
        let ranges = part_ranges(TELEGRAM_MAX_FILE_SIZE * 2);
        assert_eq!(ranges, vec![
            (0, TELEGRAM_MAX_FILE_SIZE),
            (TELEGRAM_MAX_FILE_SIZE, TELEGRAM_MAX_FILE_SIZE),
        ]);
    }

    #[test]
    fn part_ranges_one_byte_over_limit_yields_two_parts() {
        let ranges = part_ranges(TELEGRAM_MAX_FILE_SIZE + 1);
        assert_eq!(ranges, vec![
            (0, TELEGRAM_MAX_FILE_SIZE),
            (TELEGRAM_MAX_FILE_SIZE, 1),
        ]);
    }

    #[test]
    fn part_ranges_small_file_yields_single_range() {
        assert_eq!(part_ranges(100), vec![(0, 100)]);
    }

    #[test]
    fn should_split_matches_the_threshold_exactly() {
        assert!(!should_split(TELEGRAM_MAX_FILE_SIZE));
        assert!(should_split(TELEGRAM_MAX_FILE_SIZE + 1));
    }

    #[test]
    fn manifest_round_trips_through_parse() {
        let manifest = SplitManifest {
            schema_version: 1,
            name: "movie.mkv".to_string(),
            size: 5_000_000_000,
            part_count: 3,
            part_ids: vec![101, 102, 103],
        };
        let text = manifest_text(&manifest).unwrap();
        let parsed = parse_manifest(&text).expect("should parse back");
        assert_eq!(parsed.name, "movie.mkv");
        assert_eq!(parsed.part_ids, vec![101, 102, 103]);
    }

    #[test]
    fn parse_manifest_rejects_foreign_text() {
        assert!(parse_manifest("hello world").is_none());
        assert!(parse_manifest(SPLIT_MANIFEST_MARKER).is_none()); // no JSON body
        assert!(parse_manifest(&format!("{}not json", SPLIT_MANIFEST_MARKER)).is_none());
    }

    #[test]
    fn is_split_part_only_matches_the_part_marker() {
        assert!(is_split_part(&part_caption(0, 3, "x.zip")));
        assert!(!is_split_part(SPLIT_MANIFEST_MARKER));
        assert!(!is_split_part("random caption"));
    }

    #[test]
    fn locate_offset_at_the_very_start() {
        let ranges = part_ranges(TELEGRAM_MAX_FILE_SIZE * 2 + 500);
        assert_eq!(locate_offset(&ranges, 0), (0, 0));
    }

    #[test]
    fn locate_offset_exactly_at_a_part_boundary() {
        let ranges = part_ranges(TELEGRAM_MAX_FILE_SIZE * 2 + 500);
        // The first byte of the second part should resolve to (1, 0), not
        // (0, TELEGRAM_MAX_FILE_SIZE) — an off-by-one here would silently
        // re-download/re-serve one whole extra part.
        assert_eq!(locate_offset(&ranges, TELEGRAM_MAX_FILE_SIZE), (1, 0));
    }

    #[test]
    fn locate_offset_mid_part() {
        let ranges = part_ranges(TELEGRAM_MAX_FILE_SIZE * 2 + 500);
        assert_eq!(locate_offset(&ranges, TELEGRAM_MAX_FILE_SIZE + 100), (1, 100));
    }

    #[test]
    fn locate_offset_in_the_last_part() {
        let ranges = part_ranges(TELEGRAM_MAX_FILE_SIZE * 2 + 500);
        assert_eq!(locate_offset(&ranges, TELEGRAM_MAX_FILE_SIZE * 2 + 499), (2, 499));
    }

    #[test]
    fn locate_offset_single_part_file() {
        let ranges = part_ranges(100);
        assert_eq!(locate_offset(&ranges, 50), (0, 50));
    }
}
