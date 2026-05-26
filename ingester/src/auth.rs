//! Authentication service for the ingester endpoints.
//!
//! Handles validating `Authorization: Bearer hlly_...` headers against
//! Redis (cache) and Postgres (source of truth).

use deadpool_postgres::{Config, ManagerConfig, Pool, RecyclingMethod};
use redis::AsyncCommands;
use sha2::{Digest, Sha256};
use tokio_postgres::NoTls;
use uuid::Uuid;

/// The default project ID for local dev when HALLEY_AUTH_REQUIRED=false.
/// Matches DEV_PROJECT_ID in dashboard/src/lib/session.ts.
const DEV_PROJECT_ID: &str = "a2c7a9a8-2e1b-4d1a-9f0b-000000000001";

#[derive(Clone)]
pub struct AuthService {
    redis_client: redis::Client,
    pg_pool: Pool,
    auth_required: bool,
    dev_project_id: Uuid,
}

impl AuthService {
    /// Create a new AuthService.
    pub fn new(redis_url: &str, postgres_url: &str, auth_required: bool) -> anyhow::Result<Self> {
        let redis_client = redis::Client::open(redis_url)?;

        let mut pg_cfg = Config::new();
        pg_cfg.url = Some(postgres_url.to_string());
        pg_cfg.manager = Some(ManagerConfig {
            recycling_method: RecyclingMethod::Fast,
        });

        let pg_pool = pg_cfg.create_pool(Some(deadpool_postgres::Runtime::Tokio1), NoTls)?;

        let dev_project_id = Uuid::parse_str(DEV_PROJECT_ID).unwrap();

        Ok(Self {
            redis_client,
            pg_pool,
            auth_required,
            dev_project_id,
        })
    }

    /// Is authentication required?
    pub fn is_auth_required(&self) -> bool {
        self.auth_required
    }

    /// The default dev project ID to use when auth is bypassed.
    pub fn default_project_id(&self) -> Uuid {
        self.dev_project_id
    }

    /// Validate a bearer token and return the associated project_id.
    pub async fn validate_token(&self, token: &str) -> anyhow::Result<Option<Uuid>> {
        // Hash incoming key with SHA-256
        let hash_vec = Sha256::digest(token.as_bytes());
        let hash_hex = hex::encode(hash_vec);
        let redis_key = format!("hlly_key_hash:{}", hash_hex);

        // Check Redis
        let mut conn = match self.redis_client.get_multiplexed_async_connection().await {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = %e, "Redis connection failed during auth check");
                return Ok(None);
            }
        };

        let cached: Option<String> = match conn.get(&redis_key).await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "Redis GET failed during auth check");
                None
            }
        };

        if let Some(proj_id_str) = cached {
            if let Ok(proj_id) = Uuid::parse_str(&proj_id_str) {
                return Ok(Some(proj_id));
            }
        }

        // Redis miss -> Check Postgres
        let pg_conn = match self.pg_pool.get().await {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = %e, "Postgres connection failed during auth check");
                return Ok(None);
            }
        };

        let stmt = match pg_conn
            .prepare("SELECT project_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL")
            .await
        {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(error = %e, "Postgres prepare failed during auth check");
                return Ok(None);
            }
        };

        let row_opt = match pg_conn.query_opt(&stmt, &[&hash_hex]).await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "Postgres query failed during auth check");
                return Ok(None);
            }
        };

        if let Some(row) = row_opt {
            let project_id: Uuid = row.get(0);

            // Cache in Redis for 60 seconds
            let _: () = conn
                .set_ex(&redis_key, project_id.to_string(), 60)
                .await
                .unwrap_or_else(|e| {
                    tracing::warn!(error = %e, "Redis SETEX failed during auth check");
                });

            return Ok(Some(project_id));
        }

        Ok(None)
    }
}
