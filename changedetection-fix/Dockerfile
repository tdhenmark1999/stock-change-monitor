# changedetection.io 0.55.8 with the persistence fix applied on top.
FROM ghcr.io/dgtlmoon/changedetection.io:0.55.8

COPY persistence-fix.patch /tmp/persistence-fix.patch
RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends patch \
    && patch -p1 -d /app < /tmp/persistence-fix.patch \
    && rm -rf /tmp/persistence-fix.patch /var/lib/apt/lists/*

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD python3 -c "import tempfile,urllib.request; tempfile.NamedTemporaryFile(dir='/datastore').close(); urllib.request.urlopen('http://127.0.0.1:5000/', timeout=8)"
