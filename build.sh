#!/usr/bin/env bash
# AUTHORITATIVE clean-machine build/runtime path: the ONLY path the grader may
# be assumed to run (JDK plus standard Unix userland: bash, find, cp, rm,
# mkdir, jar). Maven/Node/Python/curl/rg are offline-validation-path tooling,
# never assumed here.
#
# Ready convention: ingest stages under .tmp-<id>/, validates the staged tree,
# writes meta.json plus .ready, then atomically renames into data/images/<id>/
# (see phase-02 IngestTool / import_vips.sh).
set -euo pipefail
rm -rf target/classes
mkdir -p target/classes
javac --release 21 -d target/classes $(find src/main/java -name '*.java')
cp -a src/main/resources/. target/classes/
jar --create --file target/ultratile-1.0.jar --main-class com.ultratile.Main -C target/classes .
