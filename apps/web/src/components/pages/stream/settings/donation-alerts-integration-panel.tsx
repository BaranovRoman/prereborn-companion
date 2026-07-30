"use client";

import { Button, Popconfirm, message } from "antd";
import { donationAlertsIntegrationApi } from "@/entities/donation-alerts-integration/api/donation-alerts-integration";
import type { DonationAlertsIntegrationStatus } from "@/entities/donation-alerts-integration/model/types";
import sharedStyles from "./index.module.scss";
import styles from "./steam-integration-panel.module.scss";

export const DonationAlertsIntegrationPanel = ({
    status, loading, onChanged,
}: {
    status: DonationAlertsIntegrationStatus | null; loading: boolean; onChanged: () => void;
}) => {
    const [messageApi, contextHolder] = message.useMessage();
    const connect = async () => {
        try { await donationAlertsIntegrationApi.connect(); }
        catch { messageApi.error("Не удалось начать подключение DonationAlerts"); }
    };
    const disconnect = async () => {
        try {
            await donationAlertsIntegrationApi.disconnect();
            await onChanged();
            messageApi.success("DonationAlerts отключён");
        } catch { messageApi.error("Не удалось отключить DonationAlerts"); }
    };
    return (
        <div className={sharedStyles.section}>
            {contextHolder}
            <h2 className={sharedStyles.sectionTitle}>DonationAlerts</h2>
            {loading ? <div className={styles.metaLine}>Загрузка…</div> : status?.connected ? (
                <>
                    <div className={styles.statusLine}>{status.displayName} подключён</div>
                    <div className={styles.metaLine}>Последних донатов: {status.donations.length}</div>
                    <div className={styles.actions}>
                        <Popconfirm title="Отключить DonationAlerts?" onConfirm={disconnect}>
                            <Button danger type="text">Отключить DonationAlerts</Button>
                        </Popconfirm>
                    </div>
                </>
            ) : (
                <>
                    <div className={styles.statusLine}>DonationAlerts не подключён</div>
                    <div className={styles.actions}>
                        <Button type="primary" disabled={!status?.configured} onClick={connect}>
                            Подключить DonationAlerts
                        </Button>
                    </div>
                    <div className={styles.hint}>
                        {status?.configured
                            ? "Донаты и сообщения появятся в queue-сцене."
                            : "Добавьте Client ID и Client Secret DonationAlerts в настройки сервера."}
                    </div>
                </>
            )}
        </div>
    );
};
