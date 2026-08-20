#!/bin/bash
#
# Double-click this in Finder to bring the bridge up.
#
# It updates the checkout, installs what is missing, rebuilds the plugin and
# then runs the bridge in the foreground — so leave the window open while you
# work, and close it (or press Ctrl-C) when you are done.

cd "$(dirname "$0")" || exit 1

bold=$(tput bold 2>/dev/null || echo '')
dim=$(tput dim 2>/dev/null || echo '')
red=$(tput setaf 1 2>/dev/null || echo '')
green=$(tput setaf 2 2>/dev/null || echo '')
reset=$(tput sgr0 2>/dev/null || echo '')

step() { printf '\n%s==>%s %s%s%s\n' "$green" "$reset" "$bold" "$1" "$reset"; }
warn() { printf '%s!  %s%s\n' "$red" "$1" "$reset"; }

# Keep the window readable if something fails, instead of vanishing.
die() {
  warn "$1"
  printf '\n%sPress return to close this window.%s\n' "$dim" "$reset"
  read -r _
  exit 1
}

printf '%sFigma to Claude%s\n' "$bold" "$reset"
printf '%s%s%s\n' "$dim" "$PWD" "$reset"

step 'Checking Node'

# A double-clicked script gets a login shell without Homebrew on the PATH.
add_brew_to_path() {
  for candidate in /opt/homebrew/bin /usr/local/bin; do
    [ -d "$candidate" ] || continue
    case ":$PATH:" in
      *":$candidate:"*) ;;
      *) export PATH="$candidate:$PATH" ;;
    esac
  done
}

command -v node >/dev/null 2>&1 || add_brew_to_path

if ! command -v node >/dev/null 2>&1; then
  warn 'Node is not installed.'
  if command -v brew >/dev/null 2>&1; then
    printf '\n   Install it now with %sbrew install node%s? [y/N] ' "$bold" "$reset"
    read -r reply
    case "$reply" in
      [yY]|[yY][eE][sS])
        step 'Installing Node'
        brew install node 2>&1 | sed 's/^/   /' || die 'brew install node failed.'
        add_brew_to_path
        ;;
      *)
        die 'Node is required. Install it with: brew install node'
        ;;
    esac
  else
    warn 'Homebrew is not installed either, so Node cannot be installed automatically.'
    warn 'Install Homebrew from https://brew.sh and run this again,'
    die  'or install Node directly from https://nodejs.org.'
  fi
fi

command -v node >/dev/null 2>&1 || die 'Node installed but still not on PATH. Open a new Terminal and run this again.'
printf 'node %s\n' "$(node -v)"

step 'Updating'
if [ -d .git ]; then
  git pull --ff-only 2>&1 | sed 's/^/   /' || warn 'Could not pull — carrying on with what is here.'
else
  warn 'This folder is not a git checkout, so it cannot update itself.'
  warn 'For updates, clone the repository instead of downloading a ZIP.'
fi

step 'Installing dependencies'
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  npm install --no-audit --no-fund 2>&1 | tail -3 | sed 's/^/   /' || die 'npm install failed.'
else
  printf '   already up to date\n'
fi

step 'Building the plugin'
npm run build 2>&1 | sed 's/^/   /' || die 'The build failed.'

MANIFEST="$PWD/manifest.json"
command -v pbcopy >/dev/null 2>&1 && printf '%s' "$MANIFEST" | pbcopy

step 'Import this once, on this machine'
cat <<INSTRUCTIONS
   Figma desktop app → menu → Plugins → Development
     → Import plugin from manifest…
     → $MANIFEST
INSTRUCTIONS
command -v pbcopy >/dev/null 2>&1 && printf '   %s(that path is on your clipboard — ⌘⇧G in the file picker, then ⌘V)%s\n' "$dim" "$reset"
cat <<'INSTRUCTIONS'

   After that, run the plugin from Plugins → Development → Figma to Claude
   in any file. The Claude tab connects to this window on its own.
INSTRUCTIONS

step 'Bridge running — leave this window open'
printf '%sCtrl-C to stop.%s\n\n' "$dim" "$reset"
npm run bridge || warn 'The bridge stopped with an error — see above.'

printf '\n%sBridge stopped. Press return to close this window.%s\n' "$dim" "$reset"
read -r _
