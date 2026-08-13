//! Permission bitflags for the "Temp Link Generator" folder-scoped share
//! links (`folder_shares` table / `/s/{token}` routes). Kept separate from
//! the legacy single-file `shared_links`/`/d/{token}` path, which has no
//! permission concept and stays download-only.

bitflags::bitflags! {
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct SharePermissions: i64 {
        const UPLOAD = 0b0001;
        const DOWNLOAD = 0b0010;
        const UPDATE = 0b0100;
        const DELETE = 0b1000;
    }
}

#[cfg(test)]
mod tests {
    use super::SharePermissions;

    #[test]
    fn combines_and_checks_individual_bits() {
        let perms = SharePermissions::UPLOAD | SharePermissions::DOWNLOAD;
        assert!(perms.contains(SharePermissions::UPLOAD));
        assert!(perms.contains(SharePermissions::DOWNLOAD));
        assert!(!perms.contains(SharePermissions::UPDATE));
        assert!(!perms.contains(SharePermissions::DELETE));
    }

    #[test]
    fn round_trips_through_raw_bits() {
        let perms = SharePermissions::DELETE | SharePermissions::UPDATE;
        let raw = perms.bits();
        assert_eq!(SharePermissions::from_bits_truncate(raw), perms);
    }
}
