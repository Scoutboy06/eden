#!/usr/bin/env zsh
setopt errexit nounset
zmodload zsh/zpty

zpty shell bash --noprofile --norc -i
trap 'zpty -d shell' EXIT

zpty -w shell "stty -echo; PS1=''; PS2=''; bind 'set bell-style none'; eden() { echo \"RESULT:\$*\"; }; source ${(q)1}; echo COMPLETION_READY"
zpty -r shell output $'*COMPLETION_READY\r\n*'
zpty -w -n shell "$2"$'\t\n'
zpty -r shell output $'*RESULT:*\r\n*'
print -rn -- "$output"
