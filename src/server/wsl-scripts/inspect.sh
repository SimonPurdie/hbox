session_id=$1
state_root=${XDG_STATE_HOME:-"$HOME/.local/state"}/hbox/sessions/$session_id
if [ -r "$state_root/exit" ]; then
  IFS= read -r exit_code < "$state_root/exit"
  printf 'exited\t%s\n' "$exit_code"
  exit 0
fi
if [ ! -r "$state_root/boot" ] || [ ! -r "$state_root/pid" ] || [ ! -r "$state_root/start" ]; then
  printf 'pending\n'
  exit 0
fi
IFS= read -r expected_boot < "$state_root/boot"
IFS= read -r child_pid < "$state_root/pid"
IFS= read -r expected_start < "$state_root/start"
current_boot=$(cat /proc/sys/kernel/random/boot_id) || exit 70
if [ "$current_boot" != "$expected_boot" ]; then
  printf 'disconnected\twsl_restarted\n'
  exit 0
fi
case "$child_pid" in
  ''|*[!0-9]*)
    printf 'disconnected\tinvalid_identity\n'
    exit 0
    ;;
esac
if [ ! -r "/proc/$child_pid/stat" ] || [ ! -r "/proc/$child_pid/environ" ]; then
  printf 'missing\n'
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
  printf 'disconnected\tidentity_mismatch\n'
  exit 0
fi
if ! tr '\000' '\n' < "/proc/$child_pid/environ" | grep -F -x -q "HBOX_SESSION_ID=$session_id"; then
  printf 'disconnected\ttoken_mismatch\n'
  exit 0
fi
if ! kill -0 "$child_pid" 2>/dev/null; then
  printf 'missing\n'
  exit 0
fi
printf 'alive\t%s\n' "$child_pid"
