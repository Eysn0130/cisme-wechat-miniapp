use cisme_rust_poc::{Config, app, pool};
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let config = Config::from_env().map_err(std::io::Error::other)?;
    let bind = config.bind.clone();
    let application = app(config.clone(), pool(&config)?);
    let listener = TcpListener::bind(&bind).await?;
    info!(event = "rust_poc_listening", %bind);
    axum::serve(listener, application)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
