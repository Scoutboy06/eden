export const runtime = `_eden_bash_complete() {
  local -a words=() options=() value_options=() commands=() choices=()
  local command_id=0 position=0 options_ended=false pending_option=''
  local current='' word='' value_option='' value_prefix='' reply_prefix=''
  local candidate='' flag='' index=0 reply_offset=0
  COMPREPLY=()

  _eden_bash_join_wordbreaks
  _eden_bash_load_command "$command_id"

  for ((index = 1; index < \${#words[@]} - 1; index++)); do
    word=\${words[index]}
    _eden_bash_consume_word
  done

  current=\${words[\${#words[@]} - 1]}
  _eden_bash_choose_candidates
  _eden_bash_match_candidates
}

_eden_bash_join_wordbreaks() {
  local token='' previous='' last=0
  for ((index = 0; index <= COMP_CWORD; index++)); do
    token=\${COMP_WORDS[index]}
    last=$((\${#words[@]} - 1))
    previous=''
    if ((last >= 0)); then previous=\${words[last]}; fi
    if ((last > 0)) && [[ $token == '=' || $token == ':' || $previous == *= || $previous == *: ]]; then
      words[last]+=$token
    else
      words+=("$token")
    fi
  done
  current=\${words[\${#words[@]} - 1]}
  reply_offset=$((\${#current} - \${#COMP_WORDS[COMP_CWORD]}))
  if [[ \${COMP_WORDS[COMP_CWORD]} == '=' || \${COMP_WORDS[COMP_CWORD]} == ':' ]]; then
    reply_offset=\${#current}
  fi
}

_eden_bash_consume_word() {
  if [[ -n $pending_option ]]; then
    pending_option=''
  elif [[ $word == '--' && $options_ended == false ]]; then
    options_ended=true
  elif [[ $options_ended == false && $word == -* ]]; then
    if _eden_bash_find_value_option "$word" && [[ -z $value_prefix ]]; then
      pending_option=$value_option
    fi
  elif ((position == 0)) && _eden_bash_enter_command "$command_id:$word"; then
    position=0
    _eden_bash_load_command "$command_id"
  else
    ((position += 1))
  fi
}

_eden_bash_find_value_option() {
  local input=$1
  value_option=''
  value_prefix=''
  for flag in "\${value_options[@]}"; do
    if [[ $input == "$flag" ]]; then
      value_option=$flag
      return 0
    elif [[ $flag == --* && $input == "$flag="* ]]; then
      value_option=$flag
      value_prefix=$flag=
      return 0
    elif [[ $flag != --* && $input == "$flag"* ]]; then
      value_option=$flag
      value_prefix=$flag
      return 0
    fi
  done
  return 1
}

_eden_bash_choose_candidates() {
  if [[ -n $pending_option ]]; then
    _eden_bash_load_choices "$command_id:$pending_option"
  elif [[ $options_ended == false && $current == -* ]]; then
    if _eden_bash_find_value_option "$current" && [[ -n $value_prefix ]]; then
      reply_prefix=$value_prefix
      _eden_bash_load_choices "$command_id:$value_option"
    else
      choices=("\${options[@]}")
    fi
  else
    _eden_bash_load_choices "$command_id:$position"
    if ((position == 0)); then
      choices+=("\${commands[@]}")
    fi
  fi
}

_eden_bash_match_candidates() {
  for candidate in "\${choices[@]}"; do
    candidate=$reply_prefix$candidate
    if [[ $candidate == "$current"* ]]; then
      printf -v candidate '%q' "\${candidate:reply_offset}"
      COMPREPLY+=("$candidate")
    fi
  done
  return 0
}`;
