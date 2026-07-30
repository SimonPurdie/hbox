session_id=$1
stop_mode=$2
shift 2
state_root=${XDG_STATE_HOME:-"$HOME/.local/state"}/hbox/sessions/$session_id
if [ ! -r "$state_root/boot" ] || [ ! -r "$state_root/pid" ] || [ ! -r "$state_root/start" ]; then
  printf 'not_verified\n'
  exit 3
fi
IFS= read -r expected_boot < "$state_root/boot"
IFS= read -r child_pid < "$state_root/pid"
IFS= read -r expected_start < "$state_root/start"
current_boot=$(cat /proc/sys/kernel/random/boot_id) || exit 70
if [ "$current_boot" != "$expected_boot" ]; then
  printf 'not_verified\n'
  exit 3
fi
case "$child_pid" in
  ''|*[!0-9]*)
    printf 'not_verified\n'
    exit 3
    ;;
esac
if [ ! -r "/proc/$child_pid/stat" ] || [ ! -r "/proc/$child_pid/environ" ]; then
  printf 'already_stopped\n'
  exit 0
fi
read_target_stat() {
  stat_line=$(cat "/proc/$child_pid/stat")
  stat_tail=${stat_line##*) }
  set -- $stat_tail
  process_group=$3
  current_start=${20}
}
read_target_stat
if [ "$current_start" != "$expected_start" ] || [ "$process_group" != "$child_pid" ]; then
  printf 'not_verified\n'
  exit 3
fi
if ! tr '\000' '\n' < "/proc/$child_pid/environ" | grep -F -x -q "HBOX_SESSION_ID=$session_id"; then
  printf 'not_verified\n'
  exit 3
fi

stop_command_group() {
  if [ ! -r "$state_root/stop-pid" ] || [ ! -r "$state_root/stop-start" ]; then
    return
  fi
  IFS= read -r stop_pid < "$state_root/stop-pid"
  IFS= read -r expected_stop_start < "$state_root/stop-start"
  case "$stop_pid" in
    ''|*[!0-9]*) return ;;
  esac
  if [ ! -r "/proc/$stop_pid/stat" ] || [ ! -r "/proc/$stop_pid/environ" ]; then
    return
  fi
  stop_stat_line=$(cat "/proc/$stop_pid/stat")
  stop_stat_tail=${stop_stat_line##*) }
  set -- $stop_stat_tail
  stop_group=$3
  current_stop_start=${20}
  if [ "$current_stop_start" != "$expected_stop_start" ] || [ "$stop_group" != "$stop_pid" ]; then
    return
  fi
  if ! tr '\000' '\n' < "/proc/$stop_pid/environ" | grep -F -x -q "HBOX_SESSION_STOP_ID=$session_id"; then
    return
  fi
  /usr/bin/pkill --signal KILL --pgroup "$stop_pid" 2>/dev/null || true
}

if [ "$stop_mode" = "COMMAND" ]; then
  if /bin/bash -ic '
    case "$1" in
      */*) test -x "$1" ;;
      *) command -v -- "$1" >/dev/null ;;
    esac
  ' hbox-session-stop-check "$1"; then
    HBOX_SESSION_STOP_ID=$session_id setsid /bin/bash -ic 'exec "$@"' \
      hbox-session-stop-command "$@" >> "$state_root/stop-output.log" 2>&1 &
    stop_pid=$!
    printf '%s\n' "$stop_pid" > "$state_root/stop-pid"
    stop_start=
    attempt=0
    while [ "$attempt" -lt 20 ]; do
      if [ -r "/proc/$stop_pid/stat" ]; then
        stop_stat_line=$(cat "/proc/$stop_pid/stat")
        stop_stat_tail=${stop_stat_line##*) }
        set -- $stop_stat_tail
        stop_start=${20}
        break
      fi
      attempt=$((attempt + 1))
      sleep 0.05
    done
    if [ -n "$stop_start" ]; then
      printf '%s\n' "$stop_start" > "$state_root/stop-start"
    fi
    printf 'signalled\n'
    exit 0
  fi
  stop_mode=TERM
fi

if [ "$stop_mode" = "KILL" ]; then
  stop_command_group
fi

if /usr/bin/pkill --signal "$stop_mode" --pgroup "$child_pid"; then
  printf 'signalled\n'
  exit 0
fi
if ! kill -0 "$child_pid" 2>/dev/null; then
  printf 'already_stopped\n'
  exit 0
fi
printf 'not_verified\n'
exit 3
