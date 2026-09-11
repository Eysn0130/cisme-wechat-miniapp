use std::{env, sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use sqlx::{FromRow, PgPool, postgres::PgPoolOptions};
use tower_http::{timeout::TimeoutLayer, trace::TraceLayer};
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub session_secret: String,
    pub bind: String,
    pub app_env: String,
    pub allow_dev_adapters: bool,
    pub phone_binding_enabled: bool,
    pub selected_transaction_profile: Option<String>,
    pub points_redemption_enabled: bool,
    pub ugc_go_live_gate: bool,
    pub points_rules_enabled: bool,
    pub points_finance_approval_id: Option<String>,
    pub points_finance_approval_expires_at: Option<DateTime<Utc>>,
    pub points_hold_days: i64,
    pub points_expiry_days: i64,
    pub direct_media_upload_enabled: bool,
    pub pool_max: u32,
    pub global_connection_budget: u32,
    pub instance_count: u32,
    pub pool_acquire_timeout_ms: u64,
    pub statement_timeout_ms: u64,
    pub lock_timeout_ms: u64,
    pub idle_transaction_timeout_ms: u64,
    pub route_deadline_ms: u64,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        fn boolean(name: &str, fallback: bool) -> bool {
            env::var(name)
                .map(|value| value == "true")
                .unwrap_or(fallback)
        }
        fn integer<T>(name: &str, fallback: T, minimum: T, maximum: T) -> Result<T, String>
        where
            T: std::str::FromStr + PartialOrd + Copy,
        {
            let value = match env::var(name) {
                Ok(raw) => raw.parse().map_err(|_| format!("CONFIG_INVALID:{name}"))?,
                Err(_) => fallback,
            };
            if value < minimum || value > maximum {
                return Err(format!("CONFIG_INVALID:{name}"));
            }
            Ok(value)
        }

        let database_url = env::var("DATABASE_URL").map_err(|_| "CONFIG_MISSING:DATABASE_URL")?;
        assert_test_database_url(&database_url)?;
        let app_env = env::var("APP_ENV").unwrap_or_else(|_| "test".into());
        if !matches!(app_env.as_str(), "development" | "test") {
            return Err("RUST_POC_TEST_ENV_REQUIRED".into());
        }
        let allow_dev_adapters = boolean("ALLOW_DEV_ADAPTERS", true);
        let pool_max = integer("DATABASE_POOL_MAX", 10_u32, 1, 100)?;
        let global_connection_budget =
            integer("DATABASE_GLOBAL_CONNECTION_BUDGET", 40_u32, 1, 1_000)?;
        let instance_count = integer("SERVICE_INSTANCE_COUNT", 1_u32, 1, 100)?;
        if pool_max.saturating_mul(instance_count) > global_connection_budget {
            return Err("FAIL_CLOSED:DATABASE_CONNECTION_BUDGET_EXCEEDED".into());
        }
        let profile = env::var("SELECTED_TRANSACTION_PROFILE")
            .ok()
            .filter(|value| !value.trim().is_empty());
        if profile
            .as_deref()
            .is_some_and(|value| !matches!(value, "MAKE" | "BUY"))
        {
            return Err("CONFIG_INVALID:SELECTED_TRANSACTION_PROFILE".into());
        }
        // The TypeScript implementation currently has no implemented transaction profile.
        if profile.is_some() {
            return Err("FAIL_CLOSED:TRANSACTION_PROFILE_NOT_IMPLEMENTED".into());
        }
        let approval_expiry = env::var("POINTS_FINANCE_APPROVAL_EXPIRES_AT")
            .ok()
            .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
            .map(|value| value.with_timezone(&Utc));
        Ok(Self {
            database_url,
            session_secret: env::var("APP_SESSION_SECRET")
                .map_err(|_| "CONFIG_MISSING:APP_SESSION_SECRET")?,
            bind: env::var("RUST_POC_BIND").unwrap_or_else(|_| "127.0.0.1:3210".into()),
            app_env,
            allow_dev_adapters,
            phone_binding_enabled: boolean("WECHAT_PHONE_BINDING_ENABLED", false),
            selected_transaction_profile: profile,
            points_redemption_enabled: boolean("POINTS_REDEMPTION_ENABLED", false),
            ugc_go_live_gate: boolean("UGC_GO_LIVE_GATE", false),
            points_rules_enabled: boolean("POINTS_RULES_ENABLED", false),
            points_finance_approval_id: env::var("POINTS_FINANCE_APPROVAL_ID").ok(),
            points_finance_approval_expires_at: approval_expiry,
            points_hold_days: integer("POINTS_HOLD_DAYS", 0_i64, 0, 90)?,
            points_expiry_days: integer("POINTS_EXPIRY_DAYS", 0_i64, 0, 1_095)?,
            direct_media_upload_enabled: boolean("COS_DIRECT_UPLOAD_ENABLED", false),
            pool_max,
            global_connection_budget,
            instance_count,
            pool_acquire_timeout_ms: integer(
                "DATABASE_POOL_ACQUIRE_TIMEOUT_MS",
                2_000_u64,
                100,
                60_000,
            )?,
            statement_timeout_ms: integer("DATABASE_STATEMENT_TIMEOUT_MS", 2_500_u64, 100, 60_000)?,
            lock_timeout_ms: integer("DATABASE_LOCK_TIMEOUT_MS", 750_u64, 50, 30_000)?,
            idle_transaction_timeout_ms: integer(
                "DATABASE_IDLE_TRANSACTION_TIMEOUT_MS",
                5_000_u64,
                500,
                120_000,
            )?,
            route_deadline_ms: integer("API_ROUTE_DEADLINE_MS", 8_000_u64, 250, 120_000)?,
        })
    }

    fn points_policy_enabled(&self) -> bool {
        self.points_rules_enabled
            && self
                .points_finance_approval_id
                .as_deref()
                .is_some_and(|value| !value.is_empty())
            && self
                .points_finance_approval_expires_at
                .is_some_and(|expiry| expiry > Utc::now())
            && self.points_hold_days >= 1
            && self.points_expiry_days >= 30
    }
}

fn assert_test_database_url(value: &str) -> Result<(), String> {
    let path = value
        .split('?')
        .next()
        .and_then(|url| url.rsplit('/').next())
        .unwrap_or_default();
    let decoded = path.replace("%5F", "_").replace("%5f", "_");
    let segments: Vec<_> = decoded.split('_').collect();
    if !decoded.starts_with("cisme_") || !segments.contains(&"test") {
        return Err("TEST_DATABASE_REQUIRED: Rust PoC accepts only cisme_*test* databases".into());
    }
    Ok(())
}

#[derive(Clone)]
pub struct AppState {
    config: Arc<Config>,
    pool: PgPool,
}

pub fn pool(config: &Config) -> Result<PgPool, sqlx::Error> {
    let statement_timeout_ms = config.statement_timeout_ms;
    let lock_timeout_ms = config.lock_timeout_ms;
    let idle_transaction_timeout_ms = config.idle_transaction_timeout_ms;
    PgPoolOptions::new()
        .max_connections(config.pool_max)
        .acquire_timeout(Duration::from_millis(config.pool_acquire_timeout_ms))
        .idle_timeout(Duration::from_secs(30))
        .after_connect(move |connection, _metadata| {
            Box::pin(async move {
                sqlx::query("SELECT set_config('statement_timeout',$1,false), set_config('lock_timeout',$2,false), set_config('idle_in_transaction_session_timeout',$3,false)")
                    .bind(format!("{statement_timeout_ms}ms"))
                    .bind(format!("{lock_timeout_ms}ms"))
                    .bind(format!("{idle_transaction_timeout_ms}ms"))
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .connect_lazy(&config.database_url)
}

pub fn app(config: Config, pool: PgPool) -> Router {
    let timeout = Duration::from_millis(config.route_deadline_ms);
    Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/v1/capabilities", get(capabilities))
        .route("/v1/bootstrap/settings", get(bootstrap_settings))
        .layer(TraceLayer::new_for_http())
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            timeout,
        ))
        .with_state(AppState {
            config: Arc::new(config),
            pool,
        })
}

async fn live() -> Json<Value> {
    Json(serde_json::json!({"status":"ok"}))
}

async fn ready(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    sqlx::query("SELECT 1").execute(&state.pool).await?;
    Ok(Json(serde_json::json!({"status":"ready"})))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    version: u8,
    community_preview_enabled: bool,
    social_preview_enabled: bool,
    transaction_profile: Option<String>,
    points_redemption_enabled: bool,
    ugc_go_live_gate: bool,
    points_rules_enabled: bool,
    direct_media_upload_enabled: bool,
}

async fn capabilities(State(state): State<AppState>) -> Json<Capabilities> {
    let community = state.config.allow_dev_adapters
        && matches!(state.config.app_env.as_str(), "development" | "test");
    Json(Capabilities {
        version: 1,
        community_preview_enabled: community,
        social_preview_enabled: community,
        transaction_profile: state.config.selected_transaction_profile.clone(),
        points_redemption_enabled: state.config.points_redemption_enabled,
        ugc_go_live_gate: state.config.ugc_go_live_gate,
        points_rules_enabled: state.config.points_policy_enabled(),
        direct_media_upload_enabled: state.config.direct_media_upload_enabled,
    })
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionPayload {
    principal_id: String,
    member_id: String,
    adapter: String,
    expires_at: i64,
}

fn authenticate(headers: &HeaderMap, secret: &str) -> Result<Uuid, ApiError> {
    let value = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            ApiError::domain(
                StatusCode::UNAUTHORIZED,
                "AUTH_REQUIRED",
                "Bearer session required",
            )
        })?;
    let token = value.strip_prefix("Bearer ").ok_or_else(|| {
        ApiError::domain(
            StatusCode::UNAUTHORIZED,
            "AUTH_REQUIRED",
            "Bearer session required",
        )
    })?;
    let (encoded, supplied) = token
        .split_once('.')
        .filter(|(_, signature)| !signature.contains('.'))
        .ok_or_else(|| {
            ApiError::domain(
                StatusCode::UNAUTHORIZED,
                "AUTH_INVALID",
                "Invalid session token",
            )
        })?;
    let signature = URL_SAFE_NO_PAD.decode(supplied).map_err(|_| {
        ApiError::domain(
            StatusCode::UNAUTHORIZED,
            "AUTH_INVALID",
            "Invalid session token",
        )
    })?;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| {
        ApiError::domain(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
            "Internal server error",
        )
    })?;
    mac.update(encoded.as_bytes());
    mac.verify_slice(&signature).map_err(|_| {
        ApiError::domain(
            StatusCode::UNAUTHORIZED,
            "AUTH_INVALID",
            "Invalid session token",
        )
    })?;
    let payload: SessionPayload =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).map_err(|_| {
            ApiError::domain(
                StatusCode::UNAUTHORIZED,
                "AUTH_INVALID",
                "Invalid session token",
            )
        })?)
        .map_err(|_| {
            ApiError::domain(
                StatusCode::UNAUTHORIZED,
                "AUTH_INVALID",
                "Invalid session token",
            )
        })?;
    if payload.principal_id.is_empty()
        || payload.member_id.is_empty()
        || !matches!(payload.adapter.as_str(), "wechat" | "dev")
    {
        return Err(ApiError::domain(
            StatusCode::UNAUTHORIZED,
            "AUTH_INVALID",
            "Invalid session token",
        ));
    }
    if payload.expires_at <= Utc::now().timestamp_millis() {
        return Err(ApiError::domain(
            StatusCode::UNAUTHORIZED,
            "AUTH_EXPIRED",
            "Session token expired",
        ));
    }
    payload.member_id.parse().map_err(|_| {
        ApiError::domain(
            StatusCode::UNAUTHORIZED,
            "AUTH_INVALID",
            "Invalid session token",
        )
    })
}

pub fn issue_test_token(member_id: Uuid, secret: &str, expires_at: i64) -> String {
    let payload = SessionPayload {
        principal_id: format!("member:{member_id}"),
        member_id: member_id.to_string(),
        adapter: "dev".into(),
        expires_at,
    };
    let encoded =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("serializable payload"));
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(encoded.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{encoded}.{signature}")
}

#[derive(Serialize, FromRow, Clone)]
struct Member {
    id: Uuid,
    display_name: String,
    status: String,
    created_at: DateTime<Utc>,
    wechat_handle: Option<String>,
    avatar_data_url: Option<String>,
    avatar_revision: Option<String>,
    profile_revision: i32,
    completed_at: Option<DateTime<Utc>>,
    community_visible: bool,
    public_status: String,
    public_review_note: Option<String>,
    phone_masked: Option<String>,
    bound_at: Option<DateTime<Utc>>,
}

#[derive(Serialize, FromRow)]
struct Consent {
    id: Uuid,
    submission_id: Uuid,
    purpose: String,
    granted_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
    revocation_reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Phone {
    enabled: bool,
    bound: bool,
    masked: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    profile: Member,
    phone: Phone,
    consents: Vec<Consent>,
    consents_next_cursor: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapSettings {
    scope: &'static str,
    as_of: DateTime<Utc>,
    business_version: i32,
    member: Member,
    care: Option<Value>,
    points: Option<Value>,
    settings: Settings,
}

async fn bootstrap_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<BootstrapSettings>, ApiError> {
    let member_id = authenticate(&headers, &state.config.session_secret)?;
    let mut transaction = state.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *transaction)
        .await?;
    let as_of: DateTime<Utc> = sqlx::query_scalar("SELECT transaction_timestamp()")
        .fetch_one(&mut *transaction)
        .await?;
    let member: Option<Member> = sqlx::query_as(
        r#"SELECT m.id,m.display_name,m.status,m.created_at,p.wechat_handle,p.avatar_data_url,p.avatar_revision,
        COALESCE(p.profile_revision,0) AS profile_revision,p.completed_at,COALESCE(p.community_visible,false) AS community_visible,
        COALESCE(p.public_status,'private') AS public_status,p.public_review_note,c.phone_masked,c.bound_at
        FROM member m LEFT JOIN member_profile p ON p.member_id=m.id LEFT JOIN member_contact c ON c.member_id=m.id WHERE m.id=$1"#,
    )
    .bind(member_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let member = match member {
        Some(member) if member.status == "active" => member,
        _ => {
            return Err(ApiError::domain(
                StatusCode::UNAUTHORIZED,
                "AUTH_REVOKED",
                "Member session is no longer active",
            ));
        }
    };
    let all_consents: Vec<Consent> = sqlx::query_as(
        r#"SELECT cg.id,cg.submission_id,cg.purpose,cg.granted_at,rr.requested_at AS revoked_at,rr.reason AS revocation_reason
        FROM consent_grant cg LEFT JOIN revocation_request rr ON rr.consent_grant_id=cg.id WHERE cg.member_id=$1 ORDER BY cg.granted_at DESC,id DESC LIMIT 21"#,
    )
    .bind(member_id)
    .fetch_all(&mut *transaction)
    .await?;
    transaction.commit().await?;
    let next_cursor = if all_consents.len() > 20 {
        let consent = &all_consents[19];
        Some(
            URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&(
                    consent
                        .granted_at
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    consent.id,
                ))
                .expect("serializable cursor"),
            ),
        )
    } else {
        None
    };
    let consents: Vec<_> = all_consents.into_iter().take(20).collect();
    let phone = Phone {
        enabled: state.config.phone_binding_enabled,
        bound: member.bound_at.is_some(),
        masked: member.phone_masked.clone(),
    };
    let business_version = member.profile_revision;
    Ok(Json(BootstrapSettings {
        scope: "settings",
        as_of,
        business_version,
        member: member.clone(),
        care: None,
        points: None,
        settings: Settings {
            profile: member,
            phone,
            consents,
            consents_next_cursor: next_cursor,
        },
    }))
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    title: String,
}

impl ApiError {
    fn domain(status: StatusCode, code: &'static str, title: impl Into<String>) -> Self {
        Self {
            status,
            code,
            title: title.into(),
        }
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(_error: sqlx::Error) -> Self {
        Self::domain(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
            "Internal server error",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let trace_id = Uuid::new_v4().to_string();
        let mut response = (
            self.status,
            Json(serde_json::json!({
                "type": format!("https://cisme.example/problems/{}", self.code),
                "title": self.title,
                "status": self.status.as_u16(),
                "code": self.code,
                "trace_id": trace_id,
            })),
        )
            .into_response();
        response.headers_mut().insert(
            http::header::CONTENT_TYPE,
            HeaderValue::from_static("application/problem+json"),
        );
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_database_guard_rejects_non_test_databases() {
        assert!(assert_test_database_url("postgres://u:p@db/cisme_test").is_ok());
        assert!(assert_test_database_url("postgres://u:p@db/cisme_rust_poc_test").is_ok());
        assert!(assert_test_database_url("postgres://u:p@db/cisme").is_err());
        assert!(assert_test_database_url("postgres://u:p@db/production_testimony").is_err());
    }

    #[test]
    fn token_round_trip_and_tamper_rejection() {
        let member = Uuid::new_v4();
        let token = issue_test_token(member, "secret", Utc::now().timestamp_millis() + 10_000);
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
        assert_eq!(authenticate(&headers, "secret").unwrap(), member);
        assert_eq!(
            authenticate(&headers, "different").unwrap_err().code,
            "AUTH_INVALID"
        );
    }

    #[test]
    fn expired_token_is_distinct() {
        let token = issue_test_token(Uuid::new_v4(), "secret", 0);
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
        assert_eq!(
            authenticate(&headers, "secret").unwrap_err().code,
            "AUTH_EXPIRED"
        );
    }
}
