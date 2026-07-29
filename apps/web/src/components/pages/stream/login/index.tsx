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

interface LoginFormValues {
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

export const StreamLoginPage = () => {
    const router = useRouter();
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [messageApi, contextHolder] = message.useMessage();

    // Каждая top-level страница обязана сама закрыть авто-токен перехода
    // (см. RouteTransitionProvider) - без этого прелоадер/шторка перехода
    // висят до 8-секундного failsafe.
    const { ready } = usePageReady(600);
    useEffect(() => {
        ready();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleSubmit = async (values: LoginFormValues) => {
        if (isSubmitting) return;
        setIsSubmitting(true);
        try {
            await streamAuthApi.login(values.email, values.password);
            router.push("/stream");
        } catch (error) {
            messageApi.error(
                extractErrorMessage(error, "Не удалось войти. Проверьте данные.")
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
                        src="/logo.png"
                        width={58}
                        height={58}
                        alt=""
                        priority
                    />
                    <div>
                        <div className={styles.brandName}>PreReborn Companion</div>
                        <h1 className={styles.title}>Вход в аккаунт</h1>
                    </div>
                </div>
                <p className={styles.subtitle}>
                    Управляйте стримом, матчами и виджетами оверлея в одном месте.
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
                        rules={[{ required: true, message: "Введите пароль" }]}
                    >
                        <Input.Password
                            placeholder="Пароль"
                            className={styles.input}
                            autoComplete="current-password"
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
                            Войти в Companion
                        </Button>
                    </Form.Item>
                </Form>

                <div className={styles.switchLink}>
                    Нет аккаунта? <Link href="/stream/register">Зарегистрироваться</Link>
                </div>
            </div>
        </div>
    );
};
