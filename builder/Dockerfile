# Base image is built from this repo's api/ directory. Build it first:
#   docker build -t piston-api api
ARG PISTON_IMAGE=piston-api
FROM ${PISTON_IMAGE}
ADD . /piston/packages/