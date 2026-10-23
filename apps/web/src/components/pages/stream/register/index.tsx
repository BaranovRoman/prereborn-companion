"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Form, Input, Button, message } from "antd";
import Link from "next/link";
import Image from "next/image";
import axios from "axios";
import { streamAuthApi } from "@/entities/stream-user/api/stream-auth";
import { usePageReady } from "@/shared/ui/route-transition/usePageReady";
import { LEGAL_OPERATOR, PRIVACY_PATH, TERMS_PATH } from "@/shared/config/legal";
import styles from "../stream-auth.module.scss";

interface RegisterFormValues {
    email: string;
    password: string;
}

const extractErrorMessage = (error: unknown, fallback: string): string => {
    if (axios.isAxiosError(error)) {
        const data = error.response?.data?.error;
        if (typeof data === "string") return data;
    }
    return fallback;
};

export const StreamRegisterPage = () => {
    const router = useRouter();
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [messageApi, contextHolder] = message.useMessage();

    // См. комментарий в components/pages/stream/login/index.tsx.
    const { ready } = usePageReady(600);
    useEffect(() => {
        ready();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleSubmit = async (values: RegisterFormValues) => {
        if (isSubmitting) return;
        setIsSubmitting(true);
        try {
            // Регистрация сразу авторизует пользователя - stream-auth.ts
            // (register) уже сохраняет access/refresh токены.
            await streamAuthApi.register(values.email, values.password, LEGAL_OPERATOR.effectiveDate);
            router.push("/account");
        } catch (error) {
            messageApi.error(
                extractErrorMessage(error, "Не удалось зарегистрироваться.")
            );
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className={styles.page}>
            {contextHolder}
            <div className={styles.card}>
                <div className={styles.cardHeader}>
                    <Image
                        className={styles.brandLogo}
                        src="/logo-new.png"
                        width={58}
                        height={58}
                        alt=""
                        priority
                    />
                    <div>
                        <div className={styles.brandName}>PreReborn Companion</div>
                        <h1 className={styles.title}>Создать аккаунт</h1>
                    </div>
                </div>
                <p className={styles.subtitle}>
                    Один аккаунт для сайта и Companion: после регистрации войдите в приложении с этими данными.
                </p>

                <Form
                    layout="vertical"
                    onFinish={handleSubmit}
                    className={styles.form}
                    disabled={isSubmitting}
                >
                    <Form.Item
                        name="email"
                        label="Email"
                        validateTrigger="onBlur"
                        rules={[
                            { required: true, message: "Введите email" },
                            { type: "email", message: "Неверный формат email" },
                        ]}
                    >
                        <Input
                            type="email"
                            placeholder="you@example.com"
                            className={styles.input}
                            autoComplete="email"
                        />
                    </Form.Item>

                    <Form.Item
                        name="password"
                        label="Пароль"
                        validateTrigger="onBlur"
                        rules={[
                            { required: true, message: "Введите пароль" },
                            { min: 8, message: "Минимум 8 символов" },
                        ]}
                    >
                        <Input.Password
                            placeholder="Пароль (минимум 8 символов)"
                            className={styles.input}
                            autoComplete="new-password"
                        />
                    </Form.Item>

                    {/* WK-191 - the button accepts the user agreement (public
                        offer, ст. 438 ГК РФ), which is the basis for the account
                        data (п. 5 ч. 1 ст. 6 152-ФЗ). Informing only, no consent
                        checkbox: see docs/legal/wk-191-publication-readiness.md. */}
                    <p className={styles.privacyNotice}>
                        Нажимая «Создать аккаунт», вы принимаете{" "}
                        <Link href={TERMS_PATH}>пользовательское соглашение</Link>. Email и пароль нужны только
                        для учётной записи: мы не используем их для рассылок и рекламы. Как мы храним и защищаем
                        данные — <Link href={PRIVACY_PATH}>в политике обработки персональных данных</Link>.
                    </p>

                    <Form.Item>
                        <Button
                            type="primary"
                            htmlType="submit"
                            block
                            loading={isSubmitting}
                            disabled={isSubmitting}
                            className={styles.submitButton}
                        >
                            Создать аккаунт
                        </Button>
                    </Form.Item>
                </Form>

                <div className={styles.switchLink}>
                    Уже есть аккаунт? <Link href="/stream/login">Войти</Link>
                </div>
            </div>
        </div>
    );
};
