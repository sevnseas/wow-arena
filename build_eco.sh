#!/usr/bin/env bash
# Build the headless C++ ecosystem engine into a native Python extension (.so).
set -e
cd "$(dirname "$0")"
PYINC=$(python3 -c "import sysconfig; print(sysconfig.get_path('include'))")
PB11=$(python3 -c "import pybind11; print(pybind11.get_include())")
EXT=$(python3-config --extension-suffix 2>/dev/null || echo ".so")
g++ -O3 -march=native -shared -std=c++17 -fPIC -fvisibility=hidden \
    -I"$PYINC" -I"$PB11" \
    eco_engine.cpp -o "eco_engine${EXT}"
echo "built eco_engine${EXT}"
