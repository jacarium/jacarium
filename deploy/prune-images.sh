#!/bin/bash
# Remove this project's leftover container images - and nothing else.
#
# Every stage of deploy/Containerfile (ui, taskwarrior, app) and the root
# Containerfile (builder) ends with the label
#   com.jacarium.image=<deploy|builder>  com.jacarium.stage=<name>
# An untagged image that a build leaves behind carries only its own stage's
# labels, so the label is the one reliable way to tell ours from the other
# images on the machine. This script never prunes without that label, never
# touches an image a container (running or stopped) uses, and never calls
# `image prune` / `system prune` without the label filter.
#
# Usage:
#   deploy/prune-images.sh [--component deploy|builder] [--all] [--dry-run]
#
# Default (after a successful build): remove the UNTAGGED images of the
# component except the newest one of each intermediate stage (ui,
# taskwarrior). Podman keeps a stage's result as an untagged image and that
# image IS the stage's build cache (removing it takes its intermediate
# parents with it: an unchanged rebuild went from 5 s to 34 s in testing),
# so the newest one per stage earns its disk space; an older one was
# superseded by a build with different inputs and can never be a cache hit
# again. A superseded final image (an untagged "app" / "builder" image once
# the tag moved on) is never cache and always goes.
#
# --all (deploy-podman.sh clean): remove every image of the component, tagged
# or not, except what a container still uses. The next build starts from the
# base images (a few minutes).
#
# CONTAINER_RUNTIME selects the engine (default podman; docker works too).
set -uo pipefail

ENGINE="${CONTAINER_RUNTIME:-podman}"
COMPONENT="deploy"
ALL=0
DRY_RUN=0
while [ $# -gt 0 ]; do
    case "$1" in
        --component) COMPONENT="$2"; shift ;;
        --component=*) COMPONENT="${1#*=}" ;;
        --all) ALL=1 ;;
        --dry-run) DRY_RUN=1 ;;
        -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "prune-images.sh: unknown argument $1" >&2; exit 2 ;;
    esac
    shift
done
# (`central` was the separate central server image before 3.2: still accepted
# so a target with leftover images of it can be cleaned, built by nothing now)
case "$COMPONENT" in deploy|builder|central) ;; *) echo "prune-images.sh: --component must be deploy, builder or central" >&2; exit 2 ;; esac
LABEL="com.jacarium.image=$COMPONENT"

if ! "$ENGINE" info >/dev/null 2>&1; then
    echo "prune-images.sh: $ENGINE is not available - nothing pruned"
    exit 0
fi

# Image ids every container (running or stopped) uses, full length, one per
# line. Podman prints the full id; docker may print "sha256:<id>" or a short
# id, so comparisons below are by prefix.
IN_USE="$("$ENGINE" ps -a --format '{{.ImageID}}' 2>/dev/null | sed 's/^sha256://' | sort -u)"

in_use() {
    local id="$1" full
    while IFS= read -r full; do
        [ -z "$full" ] && continue
        case "$full" in "$id"*) return 0 ;; esac
        case "$id" in "$full"*) return 0 ;; esac
    done <<< "$IN_USE"
    return 1
}

# Candidate ids, newest first, one per image (an image with several tags is
# listed once per tag by `images`).
list_candidates() {
    if [ "$ALL" = "1" ]; then
        "$ENGINE" images --filter "label=$LABEL" --format '{{.ID}}'
    else
        "$ENGINE" images --filter "label=$LABEL" --filter dangling=true --format '{{.ID}}'
    fi | awk 'NF && !seen[$1]++'
}

stage_of() {
    "$ENGINE" image inspect --format '{{index .Config.Labels "com.jacarium.stage"}}' "$1" 2>/dev/null
}

tags_of() {
    "$ENGINE" images --format '{{.ID}} {{.Repository}}:{{.Tag}}' --filter "label=$LABEL" 2>/dev/null \
        | awk -v id="$1" '$1 == id && $2 !~ /<none>/ { print $2 }'
}

remove_image() {
    local id="$1" tag
    if [ "$DRY_RUN" = "1" ]; then
        echo "would remove $id ($(stage_of "$id"))"
        return 0
    fi
    # Untag first (a multi-tag image refuses a plain rmi by id), then remove.
    while IFS= read -r tag; do
        [ -n "$tag" ] && "$ENGINE" rmi "$tag" >/dev/null 2>&1 || true
    done <<< "$(tags_of "$id")"
    if "$ENGINE" image exists "$id" 2>/dev/null; then
        "$ENGINE" rmi "$id" >/dev/null 2>&1 || "$ENGINE" rmi "$id" 2>&1 | tail -1
    fi
}

# Stages whose result is the final image: never a cache, always removable
# once untagged.
is_final_stage() {
    case "$1" in app|builder|central) return 0 ;; *) return 1 ;; esac
}

removed=0
kept=0
cached_stages=" "   # intermediate stages whose newest untagged image was kept (bash 3.2: no assoc arrays)
while IFS= read -r id; do
    [ -z "$id" ] && continue
    stage="$(stage_of "$id")"
    if in_use "$id"; then
        echo "keeping $id ($stage): a container uses it"
        kept=$((kept + 1))
        continue
    fi
    if [ "$ALL" = "0" ] && ! is_final_stage "$stage"; then
        case "$cached_stages" in
            *" $stage "*) ;;   # an older result of this stage: superseded
            *)
                cached_stages="$cached_stages$stage "   # newest: the build cache
                kept=$((kept + 1))
                continue ;;
        esac
    fi
    remove_image "$id"
    removed=$((removed + 1))
done <<< "$(list_candidates)"

echo "prune-images.sh ($COMPONENT$([ "$ALL" = "1" ] && echo ', all')): removed $removed image(s), kept $kept"
