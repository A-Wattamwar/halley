//! `POST /v1/spans/json` — stubbed on Day 3, implemented on Day 6.
//!
//! Returns 501 Not Implemented with a JSON body. Keeping the route wired
//! from Day 3 makes it impossible to accidentally miss adding the
//! handler later; tests can hit the endpoint and get a structured error.

use crate::errors::IngestError;

pub async fn post_span() -> Result<(), IngestError> {
    Err(IngestError::NotImplemented)
}
