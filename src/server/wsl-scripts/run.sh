umask 077
session_id=$1
shift
state_root=${XDG_STATE_HOME:-"$HOME/.local/state"}/hbox/sessions/$session_id
mkdir -p "$state_root" || exit 70
rm -f "$state_root/boot" "$state_root/pid" "$state_root/start" "$state_root/exit" \
  "$state_root/stop-pid" "$state_root/stop-start"
cat /proc/sys/kernel/random/boot_id > "$state_root/boot" || exit 70
HBOX_SESSION_ID=$session_id setsid /bin/bash -ic 'exec "$@"' hbox-session-command "$@" >> "$state_root/output.log" 2>&1 &
child_pid=$!
printf '%s\n' "$child_pid" > "$state_root/pid"
start_time=
attempt=0
while [ "$attempt" -lt 20 ]; do
  if [ -r "/proc/$child_pid/stat" ]; then
    stat_line=$(cat "/proc/$child_pid/stat")
    stat_tail=${stat_line##*) }
    set -- $stat_tail
    start_time=${20}
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.05
done
if [ -n "$start_time" ]; then
  printf '%s\n' "$start_time" > "$state_root/start"
fi
wait "$child_pid"
exit_code=$?
exit_tmp="$state_root/exit.$$"
printf '%s\n' "$exit_code" > "$exit_tmp"
mv "$exit_tmp" "$state_root/exit"
exit "$exit_code"
