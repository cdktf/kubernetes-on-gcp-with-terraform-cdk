FROM rust:latest as builder

WORKDIR /usr/src/app

COPY . .

RUN cargo build --release
RUN cargo install --path .

FROM scratch
COPY --from=builder /usr/local/cargo/bin/ .
USER 1000
CMD ["./app"]