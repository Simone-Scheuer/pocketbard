#!/bin/bash
# Build and publish to GitHub Pages (gh-pages branch)
set -e
npm run build
cd dist
git init -q -b gh-pages
git add -A
git commit -qm "deploy $(date +%Y-%m-%d_%H%M)"
git push -f "https://github.com/Simone-Scheuer/pocketbard.git" gh-pages
cd .. && rm -rf dist/.git
echo "Deployed."
