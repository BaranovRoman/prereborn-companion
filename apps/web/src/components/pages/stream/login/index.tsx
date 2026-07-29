"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Form, Input, Button, message } from "antd";
import Link from "next/link";
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
                <h1 className={styles.title}>Вход</h1>
                <p className={styles.subtitle}>Overlay-аккаунт стрим-сервиса</p>

                <Form
                    layout="vertical"
                    onFinish={handleSubmit}
                    className={styles.form}
                    disabled={isSubmitting}
                >
                    <Form.Item
                        name="email"
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
                            Войти
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
