ARG NERFSTUDIO_IMAGE=ghcr.io/nerfstudio-project/nerfstudio:1.1.3
FROM ${NERFSTUDIO_IMAGE}
WORKDIR /opt/solar-worker
COPY worker/requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY worker/app.py ./app.py
ENV DRONE_JOB_DIR=/workspace/drone-jobs
EXPOSE 8080
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
