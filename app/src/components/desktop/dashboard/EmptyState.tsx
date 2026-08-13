import { ReactNode } from 'react';
import { Button } from '../../ui';

type Tone = 'accent' | 'warning' | 'success' | 'info' | 'danger';

interface EmptyStateProps {
    icon: ReactNode;
    title: string;
    description?: string;
    actionLabel?: string;
    actionIcon?: ReactNode;
    actionClassName?: string;
    onAction?: () => void;
    tone?: Tone;
    tip?: ReactNode;
    compact?: boolean;
}

const TONE_VARS: Record<Tone, string> = {
    accent: '--color-app-accent',
    warning: '--color-app-warning',
    success: '--color-app-success',
    info: '--color-app-info',
    danger: '--color-app-danger',
};

// Mirrors the mobile app's illustrated empty states (a glowing colored icon
// instead of a flat gray one) so "nothing here" looks the same, deliberate
// way on both platforms. Uses the same color-mix()-over-CSS-variable
// approach already used for button variants/glows elsewhere in App.css,
// rather than image assets, so it's just styling — no new dependency.
export function EmptyState({
    icon,
    title,
    description,
    actionLabel,
    actionIcon,
    actionClassName,
    onAction,
    tone = 'accent',
    tip,
    compact = false,
}: EmptyStateProps) {
    const v = TONE_VARS[tone];
    const outer = compact ? 'h-20 w-20' : 'h-28 w-28';
    const mid = compact ? 'h-14 w-14' : 'h-20 w-20';
    const inner = compact ? 'h-9 w-9' : 'h-12 w-12';
    return (
        <div className={`flex min-h-full flex-col items-center justify-center text-center ${compact ? 'px-6 py-8' : 'px-8 py-16'}`}>
            <div
                className={`mb-4 flex items-center justify-center rounded-full ${outer}`}
                style={{ background: `color-mix(in srgb, var(${v}) 9%, transparent)` }}
            >
                <div
                    className={`flex items-center justify-center rounded-full ${mid}`}
                    style={{ background: `color-mix(in srgb, var(${v}) 16%, transparent)` }}
                >
                    <div
                        className={`relative flex items-center justify-center rounded-overlay shadow-[var(--shadow-raised)] ${inner}`}
                        style={{
                            background: `color-mix(in srgb, var(${v}) 22%, transparent)`,
                            color: `var(${v})`,
                        }}
                    >
                        {icon}
                    </div>
                </div>
            </div>

            <h3 className={`font-semibold text-app-text ${compact ? 'mb-1 text-ui' : 'mb-1.5 text-app-title'}`}>{title}</h3>
            {description && (
                <p className={`max-w-sm text-app-text-secondary ${compact ? 'mb-3 text-metadata' : 'mb-5 text-ui'}`}>
                    {description}
                </p>
            )}

            {actionLabel && onAction && (
                <Button variant="primary" onClick={onAction} leadingIcon={actionIcon} className={actionClassName}>
                    {actionLabel}
                </Button>
            )}

            {tip && <p className="mt-5 text-badge text-app-text-tertiary">{tip}</p>}
        </div>
    );
}
