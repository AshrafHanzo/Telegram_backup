import { Switch, SwitchProps } from "react-native";
import { colors } from "../theme";

export default function ThemedSwitch(props: SwitchProps) {
  return (
    <Switch
      trackColor={{ false: colors.borderStrong, true: colors.accentSoft }}
      thumbColor={props.value ? colors.accent : colors.textTertiary}
      ios_backgroundColor={colors.borderStrong}
      {...props}
    />
  );
}
