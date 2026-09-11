use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use chrono::Utc;
use cisme_rust_poc::{Config, app, issue_test_token, pool};
use serde_json::Value;
use sqlx::Executor;
use tower::ServiceExt;
use uuid::Uuid;

// This test is ignored by default because it writes a short-lived fixture. Run it only
// against the dedicated cisme_rust_poc_test database documented in README.md.
#[tokio::test]
#[ignore = "requires migrated isolated PostgreSQL test database"]
async fn reads_fastify_compatible_settings_snapshot() {
    let config = Config::from_env().expect("isolated test config");
    let database = pool(&config).expect("lazy pool");
    let connection_settings: (String, String, String) = sqlx::query_as(
        "SELECT current_setting('statement_timeout'),current_setting('lock_timeout'),current_setting('idle_in_transaction_session_timeout')",
    )
    .fetch_one(&database)
    .await
    .expect("read enforced connection settings");
    assert_eq!(
        connection_settings,
        ("2500ms".into(), "750ms".into(), "5s".into())
    );
    let member_id = Uuid::new_v4();
    let submission_id = Uuid::new_v4();
    database
        .execute(
            sqlx::query("INSERT INTO member(id,display_name) VALUES($1,$2)")
                .bind(member_id)
                .bind("Rust PoC parity fixture"),
        )
        .await
        .expect("insert member fixture");
    database
        .execute(
            sqlx::query("INSERT INTO member_profile(member_id,wechat_handle,handle_source,profile_revision) VALUES($1,$2,'self_reported',7)")
                .bind(member_id)
                .bind("rust_poc_user"),
        )
        .await
        .expect("insert profile fixture");
    database
        .execute(
            sqlx::query("INSERT INTO submission(id,member_id) VALUES($1,$2)")
                .bind(submission_id)
                .bind(member_id),
        )
        .await
        .expect("insert submission fixture");
    database
        .execute(
            sqlx::query("INSERT INTO consent_grant(submission_id,member_id,purpose,granted_at,active) VALUES($1,$2,'content_storage',now(),true)")
                .bind(submission_id)
                .bind(member_id),
        )
        .await
        .expect("insert consent fixture");

    let token = issue_test_token(
        member_id,
        &config.session_secret,
        Utc::now().timestamp_millis() + 60_000,
    );
    let response = app(config, database.clone())
        .oneshot(
            Request::builder()
                .uri("/v1/bootstrap/settings")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("router response");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("application/json")
    );
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1_000_000).await.unwrap())
            .expect("JSON body");
    assert_eq!(body["scope"], "settings");
    assert_eq!(body["businessVersion"], 7);
    assert_eq!(body["member"]["id"], member_id.to_string());
    assert_eq!(body["settings"]["profile"], body["member"]);
    assert_eq!(
        body["settings"]["consents"][0]["submission_id"],
        submission_id.to_string()
    );
    assert!(DateTimeCheck::is_rfc3339(&body["asOf"]));

    database
        .execute(sqlx::query("DELETE FROM consent_grant WHERE member_id=$1").bind(member_id))
        .await
        .expect("delete consent fixture");
    database
        .execute(sqlx::query("DELETE FROM submission WHERE id=$1").bind(submission_id))
        .await
        .expect("delete submission fixture");
    database
        .execute(sqlx::query("DELETE FROM member_profile WHERE member_id=$1").bind(member_id))
        .await
        .expect("delete profile fixture");
    database
        .execute(sqlx::query("DELETE FROM member WHERE id=$1").bind(member_id))
        .await
        .expect("delete member fixture");
}

struct DateTimeCheck;

impl DateTimeCheck {
    fn is_rfc3339(value: &Value) -> bool {
        value
            .as_str()
            .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
            .is_some()
    }
}
