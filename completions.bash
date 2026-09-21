# manual-cli bash completions
# source /c/Users/bainb/Desktop/manual-cli/completions.bash

_manual_cli() {
  local cur prev commands flags
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  commands="verify brief enforce observe doctor init inbox hooks eject mcp help"
  flags="--root --force --diff --json --budget --at --stage --dry-run -h --help"

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return 0
  fi

  case "${COMP_WORDS[1]}" in
    brief)
      if [ "$prev" = "--at" ]; then
        COMPREPLY=( $(compgen -W "$(git for-each-ref --format='%(refname:short)' refs/heads refs/tags 2>/dev/null)" -- "$cur") )
      elif [[ "$cur" == --* ]]; then
        COMPREPLY=( $(compgen -W "--budget --at --root --json" -- "$cur") )
      fi
      ;;
    verify)
      if [ "$prev" = "--diff" ]; then
        COMPREPLY=( $(compgen -W "$(git for-each-ref --format='%(refname:short)' refs/heads refs/remotes 2>/dev/null)" -- "$cur") )
      elif [[ "$cur" == --* ]]; then
        COMPREPLY=( $(compgen -W "--force --diff --root --json" -- "$cur") )
      fi
      ;;
    hooks)
      COMPREPLY=( $(compgen -W "install uninstall status" -- "$cur") )
      ;;
    inbox)
      if [ "$prev" = "accept" ]; then
        COMPREPLY=( $(compgen -W "$(ls .manual/inbox 2>/dev/null)" -- "$cur") )
      else
        COMPREPLY=( $(compgen -W "accept" -- "$cur") )
      fi
      ;;
    enforce)
      COMPREPLY=( $(compgen -W "--stage --root --json" -- "$cur") )
      ;;
    init|eject)
      COMPREPLY=( $(compgen -W "--dry-run --root --json" -- "$cur") )
      ;;
    *)
      COMPREPLY=( $(compgen -W "$flags" -- "$cur") )
      ;;
  esac
  return 0
}
complete -F _manual_cli manual
