FROM python:3.12-slim

WORKDIR /app

# Minimal system deps for Playwright + browsers
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  wget \
  gnupg \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install browser + OS deps for Chromium
RUN python -m playwright install --with-deps chromium

COPY . .

ENV PORT=8000
ENV PYTHONUNBUFFERED=1
# Render sets PORT at runtime (often 10000). We bind to whatever PORT is.
EXPOSE 8000

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
