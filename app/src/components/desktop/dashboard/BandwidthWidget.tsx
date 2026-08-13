import { BandwidthStats } from '../../../types';
import { formatBytes } from '../../../utils';

interface BandwidthWidgetProps {
    bandwidth: BandwidthStats | null;
}

// u64::MAX on the Rust side — the sentinel for "no cap set".
const UNLIMITED_SENTINEL = 18446744073709551615;

export function BandwidthWidget({ bandwidth }: BandwidthWidgetProps) {
    if (!bandwidth) return null;

    const totalBytes = bandwidth.up_bytes + bandwidth.down_bytes;
    const isUnlimited = !bandwidth.limit || bandwidth.limit >= UNLIMITED_SENTINEL;
    const percent = isUnlimited ? 0 : Math.min((totalBytes / bandwidth.limit) * 100, 100);

    return (
        <div className="mt-1.5 space-y-1 text-metadata text-app-text-secondary">
            <div className="flex justify-between">
                <span>Used Today:</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-app-border">
                <div
                    className="h-full rounded-full bg-app-accent transition-[width] duration-500 ease-out"
                    style={{ width: `${percent}%` }}
                ></div>
            </div>
            <div className="flex justify-between text-badge text-app-text-tertiary">
                <span>{formatBytes(totalBytes)}</span>
                <span>{isUnlimited ? 'Unlimited' : formatBytes(bandwidth.limit)}</span>
            </div>
        </div>
    );
}
