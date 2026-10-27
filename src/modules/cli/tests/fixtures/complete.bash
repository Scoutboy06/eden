#!/usr/bin/env bash
set -eu

source "$1"
shift
COMP_WORDS=("$@")
COMP_CWORD=$(($# - 1))

[[ $(complete -p eden) == 'complete -o noquote -F _eden_bash_complete eden' ]]
_eden_bash_complete

if ((${#COMPREPLY[@]})); then
  printf '%s\0' "${COMPREPLY[@]}"
fi
