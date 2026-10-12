#!/usr/bin/env zsh
setopt errexit nounset
zmodload zsh/zpty

zpty shell zsh -f -i
trap 'zpty -d shell' EXIT

# Run the generated script in a clean interactive shell. The command reports
# the arguments Zsh produces after completing the user's input.
zpty -w shell "stty -echo; PROMPT=''; RPROMPT=''; autoload -Uz compinit; compinit -D; eden() { print -r -- \"RESULT:\${(j: :)@}\"; }; source ${(q)1}; print COMPLETION_READY"
zpty -r shell output $'*\r\nCOMPLETION_READY\r\n*'
zpty -w -n shell "$2"$'\t\n'
zpty -r shell output $'*RESULT:*\r\n*'
print -rn -- "$output"
