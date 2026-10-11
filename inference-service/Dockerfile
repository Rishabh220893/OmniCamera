# NOT BUILT OR RUN (see inference_service/main.py). GPU image (needs the NVIDIA container toolkit on the host):
#   docker build -t omnisee-inference-gpu . && docker run --gpus all -p 8100:8100 -e INFERENCE_DEVICE=cuda:0 -e INFERENCE_API_KEY=... omnisee-inference-gpu
# CPU image:
#   docker build --build-arg BASE=python:3.11-slim --build-arg REQS=requirements.txt -t omnisee-inference .
ARG BASE=nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04
FROM ${BASE}
ARG REQS=requirements-gpu.txt
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN (command -v python3 >/dev/null || (apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/*)) \
    && (apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 && rm -rf /var/lib/apt/lists/*)
WORKDIR /app
COPY requirements.txt requirements-gpu.txt ./
RUN python3 -m pip install -r ${REQS}
COPY inference_service ./inference_service
ENV HOME=/models
VOLUME /models
EXPOSE 8100
CMD ["python3", "-m", "uvicorn", "inference_service.main:app", "--host", "0.0.0.0", "--port", "8100"]
