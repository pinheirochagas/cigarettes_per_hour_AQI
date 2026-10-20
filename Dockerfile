FROM node:22-slim AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8000
COPY requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock
COPY backend/ ./backend/
COPY --from=frontend /build/dist ./frontend/dist
RUN useradd --create-home app
USER app
EXPOSE 8000
CMD ["python", "-m", "backend.main"]
