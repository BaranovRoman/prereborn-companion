// WK-125 - thin abstraction over the OS-backed credential store, so
// storage/mod.rs's migration logic can be unit-tested against an in-memory
// fake instead of the real Windows Credential Manager / macOS Keychain /
// Linux Secret Service (slow, sometimes unavailable in a headless CI
// process, and not something a `cargo test` run should ever actually write
// entries into). Production code always goes through `OsSecretStore`;
// `#[cfg(test)]` fakes below back the `_at`-style pure functions in
// storage/mod.rs's own test module, matching that module's existing pattern
// of testing real logic against an injected dependency rather than mocking
// the OS.

/// Keyring "service" namespace every Companion secret is stored under -
/// matches the Tauri app identifier so entries are unambiguous alongside
/// whatever else might use the same OS credential store on this machine.
const SERVICE_NAME: &str = "com.romanbaranov.dota-companion";

pub trait SecretStore: Send + Sync {
    /// Persists `value` under `key`. Must be safe to call repeatedly with
    /// the same key (overwrites).
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    /// `Ok(None)` means "no entry for this key" - distinct from an error,
    /// which means the store itself couldn't be reached/queried.
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    /// Idempotent: deleting an already-absent key is `Ok(())`, not an error.
    fn delete(&self, key: &str) -> Result<(), String>;
}

pub struct OsSecretStore;

impl SecretStore for OsSecretStore {
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        keyring::Entry::new(SERVICE_NAME, key)
            .map_err(|error| error.to_string())?
            .set_password(value)
            .map_err(|error| error.to_string())
    }

    fn get(&self, key: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE_NAME, key).map_err(|error| error.to_string())?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE_NAME, key).map_err(|error| error.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

/// The store every real (non-test) call site in storage/mod.rs goes through.
pub fn os_store() -> OsSecretStore {
    OsSecretStore
}

// WK-125 - deliberately NOT part of the default `cargo test` run: this is
// the one place this crate's test suite is allowed to touch a real OS
// credential store, and only because it's `#[ignore]`d by default. Kept for
// manual local verification (passes on macOS) - NOT what CI actually runs:
// this same round trip, inside the full `cargo test --lib` binary, crashes
// with STATUS_ENTRYPOINT_NOT_FOUND on GitHub Actions' `windows-latest`
// runner before any test code runs, for reasons isolated to that combined
// test-harness binary (see examples/keyring_smoke.rs's doc comment for the
// full story) - not to `keyring`'s Windows backend itself, which the
// standalone example in examples/keyring_smoke.rs proves works correctly
// on that same runner, and which is what windows-release.yml actually
// invokes as its Windows secure-storage CI gate. Uses a synthetic key/value
// so nothing resembling a real credential is ever written under this
// service name or printed to logs.
#[cfg(test)]
mod real_store_smoke {
    use super::*;

    #[test]
    #[ignore = "touches the real OS credential store - run manually, not from CI (see examples/keyring_smoke.rs for what CI runs instead)"]
    fn os_secret_store_round_trips_a_real_os_credential() {
        let store = OsSecretStore;
        let key = "wk-125-ci-smoke-test-key";
        let value = "wk-125-ci-smoke-test-value";

        store.set(key, value).expect("set_password against the real OS credential store must succeed");
        let read_back = store.get(key).expect("get_password must succeed").expect("entry must exist after set");
        assert_eq!(read_back, value);

        store.delete(key).expect("delete_credential must succeed");
        assert!(store.get(key).expect("get_password must succeed").is_none(), "credential must be gone after delete");
    }
}

#[cfg(test)]
pub mod test_support {
    use super::SecretStore;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// In-memory stand-in for the OS credential store - lets migration logic
    /// be exercised deterministically without touching a real keychain.
    #[derive(Default)]
    pub struct FakeSecretStore {
        values: Mutex<HashMap<String, String>>,
    }

    impl SecretStore for FakeSecretStore {
        fn set(&self, key: &str, value: &str) -> Result<(), String> {
            self.values.lock().unwrap().insert(key.to_string(), value.to_string());
            Ok(())
        }

        fn get(&self, key: &str) -> Result<Option<String>, String> {
            Ok(self.values.lock().unwrap().get(key).cloned())
        }

        fn delete(&self, key: &str) -> Result<(), String> {
            self.values.lock().unwrap().remove(key);
            Ok(())
        }
    }

    /// Simulates a secure store that can never be written to (e.g. a locked/
    /// unavailable OS keychain) - every `set`/`delete` fails, `get` always
    /// reports "no entry". Used to prove migration leaves the plaintext
    /// legacy value untouched and the app stays functional when the secure
    /// write itself fails.
    #[derive(Default)]
    pub struct FailingSecretStore;

    impl SecretStore for FailingSecretStore {
        fn set(&self, _key: &str, _value: &str) -> Result<(), String> {
            Err("simulated secure storage failure".to_string())
        }

        fn get(&self, _key: &str) -> Result<Option<String>, String> {
            Ok(None)
        }

        fn delete(&self, _key: &str) -> Result<(), String> {
            Err("simulated secure storage failure".to_string())
        }
    }
}
