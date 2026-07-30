session_id=$1
case "$session_id" in
  ????????-????-????-????-????????????) ;;
  *) exit 64 ;;
esac
state_root=${XDG_STATE_HOME:-"$HOME/.local/state"}/hbox/sessions/$session_id
if [ -r "$state_root/stop-pid" ] && [ -r "$state_root/stop-start" ]; then
  IFS= read -r stop_pid < "$state_root/stop-pid"
  IFS= read -r expected_stop_start < "$state_root/stop-start"
  case "$stop_pid" in
    ''|*[!0-9]*) ;;
    *)
      if [ -r "/proc/$stop_pid/stat" ] && [ -r "/proc/$stop_pid/environ" ]; then
        stop_stat_line=$(cat "/proc/$stop_pid/stat")
        stop_stat_tail=${stop_stat_line##*) }
        set -- $stop_stat_tail
        if [ "${20}" = "$expected_stop_start" ] &&
          [ "$3" = "$stop_pid" ] &&
          tr '\000' '\n' < "/proc/$stop_pid/environ" |
            grep -F -x -q "HBOX_SESSION_STOP_ID=$session_id"; then
          /usr/bin/pkill --signal KILL --pgroup "$stop_pid" 2>/dev/null || true
        fi
      fi
      ;;
  esac
fi
rm -rf "$state_root"
