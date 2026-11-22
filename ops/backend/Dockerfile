# Slim SpacetimeDB server for Cozy Bistro.
# The official image is ~3.5 GB because it ships the Rust and .NET toolchains;
# the server itself is one binary. Build on the PC, ship with `docker save`
# (see README.md), so the box never pulls the big image.
ARG STDB_VERSION=v2.3.0
FROM clockworklabs/spacetime:${STDB_VERSION} AS src

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --create-home spacetime
COPY --from=src /opt/spacetime/spacetimedb-standalone /usr/local/bin/spacetimedb-standalone
USER spacetime
EXPOSE 3000
ENTRYPOINT ["spacetimedb-standalone"]
# The signing keys MUST live on the data volume (/stdb/keys). Every player's
# saved login is signed with them: by default they sit in the container's home
# folder and die with the container, and then every player loses their account.
CMD ["start", "--data-dir", "/stdb", "--listen-addr", "0.0.0.0:3000", \
     "--jwt-pub-key-path", "/stdb/keys/id_ecdsa.pub", \
     "--jwt-priv-key-path", "/stdb/keys/id_ecdsa", "--non-interactive"]
