# Use Python slim
FROM python:3.12-slim

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    TZ=Etc/UTC

# Install system dependencies
# Install Chromium and ChromeDriver
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-driver \
    tesseract-ocr \
    libtesseract-dev \
    libleptonica-dev \
    pkg-config \
    wget \
    unzip \
    curl \
    gnupg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*


# Install Node.js (LTS) from official source
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Chromium (headless) from Debian repo
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path
ENV CHROME_BIN=/usr/bin/chromium

# Create app directory
WORKDIR /app

# Copy requirements first for caching
COPY requirements.txt /app/

# Upgrade pip & install Python dependencies
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# Copy app source
COPY . /app

EXPOSE 5000

# Default command to run your scraper
CMD ["node", "index.js"]
