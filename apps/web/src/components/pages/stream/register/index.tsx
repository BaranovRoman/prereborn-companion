"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Form, Input, Button, message } from "antd";
import Link from "next/link";
import Image from "next/image";
import axios from "axios";
import { streamAuthApi } from "@/entities/stream-user/api/stream-auth";
import { usePageReady } from "@/shared/ui/route-transition/usePageReady";
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
            await streamAuthApi.register(values.email, values.password);
            router.push("/stream");
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
                    Подключите Companion и подготовьте оверлей для первого стрима.
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
