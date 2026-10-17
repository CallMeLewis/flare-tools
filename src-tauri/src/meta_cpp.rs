//! The meta.cpp that goes into a folder before it's uploaded to the Workshop, as DayZ Publisher writes it. A server
//! reports each mod's Workshop ID from the `publishedid` in it, so without one players see the mod as ID 0 and
//! launchers can't download it.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::mod_cpp::quoted;

/// .NET ticks (100 ns since 0001-01-01) at the Unix epoch.
const UNIX_EPOCH_TICKS: u64 = 621_355_968_000_000_000;
/// The flag .NET's `DateTime.ToBinary` sets on a UTC time.
const UTC_KIND: u64 = 1 << 62;

/// The time as DayZ Publisher writes it: `DateTime.UtcNow.ToBinary()`.
fn timestamp(time: SystemTime) -> u64 {
    let ticks = time.duration_since(UNIX_EPOCH).map(|d| d.as_nanos() / 100).unwrap_or(0) as u64;
    (UNIX_EPOCH_TICKS + ticks) | UTC_KIND
}

pub fn create(published_id: u64, name: &str, time: SystemTime) -> String {
    format!(
        "protocol = 1;\r\npublishedid = {published_id};\r\nname = {};\r\ntimestamp = {};\r\n",
        quoted(name),
        timestamp(time)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn writes_what_dayz_publisher_writes() {
        // 2026-04-26 01:39:25.1773347 UTC, from a meta.cpp DayZ Publisher wrote.
        let time = UNIX_EPOCH + Duration::from_nanos(1_777_167_565_177_334_700);
        assert_eq!(
            create(3711528293, "Deerisle 5.9 - Weapon Sound Fixes", time),
            "protocol = 1;\r\npublishedid = 3711528293;\r\nname = \"Deerisle 5.9 - Weapon Sound Fixes\";\r\n\
             timestamp = 5250813662079161251;\r\n"
        );
    }

    #[test]
    fn escapes_quotes_in_the_name() {
        assert!(create(1, "The \"Big\" Mod", UNIX_EPOCH).contains("name = \"The \"\"Big\"\" Mod\";"));
    }
}
