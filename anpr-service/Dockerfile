# GPU image (default). CPU image:
#   docker build --build-arg BASE=python:3.11-slim --build-arg REQS=requirements.txt -t omnisee-anpr .
# GPU image (needs the NVIDIA container toolkit on the host):
#   docker build -t omnisee-anpr-gpu . && docker run --gpus all -p 8000:8000 -e ANPR_DEVICE=cuda -e ANPR_API_KEY=... omnisee-anpr-gpu
ARG BASE=nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04
FROM ${BASE}
ARG REQS=requirements-gpu.txt

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN (command -v python3 >/dev/null || (apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/*)) \
    && (apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 && rm -rf /var/lib/apt/lists/*)
WORKDIR /app
COPY requirements.txt requirements-gpu.txt ./
RUN python3 -m pip install -r ${REQS}
COPY anpr_service ./anpr_service
# Model weights are downloaded on first start and cached here; mount a volume to keep them.
ENV HOME=/models
VOLUME /models
EXPOSE 8000
CMD ["python3", "-m", "uvicorn", "anpr_service.main:app", "--host", "0.0.0.0", "--port", "8000"]
