#!/bin/bash
# build-check.sh — Stop hook
# Runs after any agent completes. Verifies the project builds with zero warnings.
# Advisory only — prints warnings but does not block.

# Detect project type and build command
if [ -f "package.json" ]; then
  # Check if a build script exists
  BUILD_CMD=$(node -e "const p=require('./package.json'); console.log(p.scripts?.build || '')" 2>/dev/null)
  
  if [ -z "$BUILD_CMD" ]; then
    # No build script — common for simple projects, skip silently
    exit 0
  fi
  
  echo "🔨 build-check: running npm run build..."
  OUTPUT=$(npm run build 2>&1)
  EXIT_CODE=$?
  
  if [ $EXIT_CODE -ne 0 ]; then
    echo "❌ build-check: build FAILED (exit code $EXIT_CODE)"
    echo "   Review the build output before committing."
    exit 0  # Advisory, don't block
  fi
  
  # Check for warnings in output
  WARNING_COUNT=$(echo "$OUTPUT" | grep -ci "warning" || true)
  
  if [ "$WARNING_COUNT" -gt 0 ]; then
    echo "⚠️  build-check: build succeeded but found $WARNING_COUNT warning(s)."
    echo "   Zero-warning policy: fix warnings before considering the task done."
    echo "   If a warning cannot be fixed, document it in CLAUDE.md Build Warning Exceptions."
  else
    echo "✅ build-check: build clean (0 warnings)"
  fi

elif [ -f "pyproject.toml" ] || [ -f "requirements.txt" ]; then
  # Python project — run linter if available
  if command -v ruff &> /dev/null; then
    echo "🔨 build-check: running ruff check..."
    OUTPUT=$(ruff check . 2>&1)
    if [ $? -ne 0 ]; then
      echo "⚠️  build-check: ruff found issues."
    else
      echo "✅ build-check: ruff clean"
    fi
  fi
fi

exit 0
