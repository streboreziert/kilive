#!/bin/sh
# usage: ph.sh ids [json]
cd /home/claude/noeti
OPTS=${2:-'{"background":"studio","ss":1}'}
timeout 1500 python3 /tmp/claude-0/qa/photo.py "$1" "$OPTS" > /tmp/claude-0/qa/photo.log 2>&1
