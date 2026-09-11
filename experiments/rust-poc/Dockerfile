FROM rust:1.98.1-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY src ./src
RUN cargo build --locked --release

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --no-create-home cisme
COPY --from=build /src/target/release/cisme-rust-poc /usr/local/bin/cisme-rust-poc
USER 10001
EXPOSE 3210
ENTRYPOINT ["cisme-rust-poc"]

