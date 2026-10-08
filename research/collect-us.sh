#!/bin/sh
# One collection round for US App Store reviews: newest 500 + most helpful 500 per app, merged into
# data/research/reviews-us.json (de-duplicated, only grows). Run it every 8-12 hours to build history.
cd "$(dirname "$0")/.." || exit 1
COUNTRIES=us SORT=mostrecent  OUT=data/research/.pull-recent.json  node research/fetch-app-store-reviews.js >/dev/null &&
COUNTRIES=us SORT=mosthelpful OUT=data/research/.pull-helpful.json node research/fetch-app-store-reviews.js >/dev/null &&
COUNTRIES=us node research/merge-reviews.js data/research/reviews-us.json data/research/.pull-recent.json data/research/.pull-helpful.json &&
python3 research/pain-signals.py data/research/reviews-us.json | sed -n 3p
