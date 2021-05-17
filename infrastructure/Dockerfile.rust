FROM rust:latest

WORKDIR /usr/src/app

COPY . .

RUN cargo build --release
RUN cargo install --path .


CMD ["/usr/local/cargo/bin/app"]