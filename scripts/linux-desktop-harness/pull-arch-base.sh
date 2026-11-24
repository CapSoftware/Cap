#!/usr/bin/env bash
# Pulls the Arch Linux base image arch.Dockerfile starts from and tags it
# archlinux:latest, so `docker build` uses it without asking Docker Hub.
#
# Anonymous Docker Hub pulls are rate limited per IP, and CI runners that
# share a recently busy IP get 429 Too Many Requests. AWS's and Google's
# public copies of Docker's official images serve the same image without that
# limit; Docker Hub stays as the last resort.
set -euo pipefail

for image in \
  public.ecr.aws/docker/library/archlinux:latest \
  mirror.gcr.io/library/archlinux:latest \
  docker.io/library/archlinux:latest; do
  if docker pull -q "$image" >/dev/null; then
    docker tag "$image" archlinux:latest
    echo "archlinux:latest from $(docker image inspect -f '{{index .RepoDigests 0}}' "$image")"
    exit 0
  fi
  echo "::warning::could not pull $image"
done
echo "::error::could not pull the Arch Linux base image from any registry"
exit 1
