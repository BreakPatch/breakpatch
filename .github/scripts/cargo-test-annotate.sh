#!/bin/sh
# Runs a test command (`cargo test …`) and, when it fails, turns each panic in its output into a
# GitHub `::error` annotation: the test, file and line, and the panic's message (the assertion's
# left and right too). Annotations can be read through the API (check-runs/<job>/annotations) when
# the job's log can't, so a failure says what broke without the log.
#
#   sh .github/scripts/cargo-test-annotate.sh cargo test --locked some_test -- --ignored
#
# Paths in a panic are relative to the crate; they're made relative to the repo root here (the
# command runs in the current directory). The command's exit status is passed on.
set -u

out=$(mktemp)
status_file=$(mktemp)
{ "$@" 2>&1; echo $? > "$status_file"; } | tee "$out"
status=$(cat "$status_file")
rm -f "$status_file"

if [ "$status" -ne 0 ]; then
  prefix=$(git rev-parse --show-prefix 2>/dev/null || true)
  awk -v prefix="$prefix" -v cmd="$*" -v status="$status" '
    function esc(s) { gsub(/%/, "%25", s); gsub(/\r/, "%0D", s); gsub(/\n/, "%0A", s); return s }
    function prop(s) { s = esc(s); gsub(/:/, "%3A", s); gsub(/,/, "%2C", s); return s }
    function flush() {
      if (!inpanic) return
      printf "::error file=%s,line=%s,col=%s,title=%s::%s\n", prop(file), line, col, prop("panicked: " test), esc(msg)
      found++; inpanic = 0
    }
    # thread '"'"'mod::test'"'"' (1234) panicked at src/x.rs:803:37:   (newer Rust adds the thread id)
    /^thread .* panicked at / {
      flush()
      test = $0; sub(/^thread '"'"'/, "", test); sub(/'"'"'( \([0-9]+\))? panicked at .*/, "", test)
      loc = $0; sub(/.* panicked at /, "", loc); sub(/:$/, "", loc)
      n = split(loc, p, ":"); col = p[n]; line = p[n - 1]; file = p[1]
      for (i = 2; i < n - 1; i++) file = file ":" p[i]
      if (file !~ /^\//) file = prefix file
      msg = ""; lines = 0; inpanic = 1
      next
    }
    inpanic {
      if ($0 == "" || $0 ~ /^(note: |stack backtrace:|failures:|test |---- )/ || lines >= 20) { flush(); next }
      msg = (msg == "" ? $0 : msg "\n" $0); lines++
      next
    }
    /^error(\[E[0-9]+\])?: / && errors < 10 { errs = errs (errs == "" ? "" : "\n") $0; errors++ }
    END {
      flush()
      if (!found) {
        printf "::error title=%s::%s\n", prop("exit " status ": " cmd), esc(errs == "" ? "no panic in the output; see the log" : errs)
      }
    }
  ' "$out"
fi
rm -f "$out"
exit "$status"
