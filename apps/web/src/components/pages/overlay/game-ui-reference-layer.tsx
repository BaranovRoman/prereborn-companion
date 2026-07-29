export interface ReferenceBackgroundImage {
    url: string;
    // 0..1 - см. usage в use-reference-background.ts, хранится там же в
    // IndexedDB вместе с самим изображением.
    opacity: number;
}

interface GameUiReferenceLayerProps {
    sceneWidth: number;
    sceneHeight: number;
    mode: "preview" | "live";
    referenceImage?: ReferenceBackgroundImage | null;
}

// Точка расширения под будущую схему интерфейса Dota (hero portrait/name/
// level zones) поверх которой позже встанет камера стримера - см. комментарий
// про anti-snipe layer рядом. Сейчас единственный реальный контент - "фон для
// примерки" (загруженный скриншот игры), который редактор использует, чтобы
// сверить расстановку виджетов с реальным HUD. Жёстко завязан на mode:
// рендерится ТОЛЬКО в editor-превью - см. задачу "никогда не попадать в
// публичный overlay" (двойная защита: OverlayCanvas на /overlay/:token
// вообще не передаёт referenceImage, но проверка mode здесь - на случай если
// это когда-нибудь изменится).
export const GameUiReferenceLayer = ({
    sceneWidth,
    sceneHeight,
    mode,
    referenceImage,
}: GameUiReferenceLayerProps) => {
    if (mode !== "preview" || !referenceImage) return null;

    return (
        <img
            src={referenceImage.url}
            alt=""
            draggable={false}
            style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: sceneWidth,
                height: sceneHeight,
                // object-fit: contain (а не cover) - главное требование
                // задачи: при совпадении aspect ratio скриншот ложится на
                // сцену 1:1 без обрезки, при несовпадении - остаётся целиком
                // видимым с полями по краям, а не растягивается/обрезается.
                objectFit: "contain",
                opacity: referenceImage.opacity,
                pointerEvents: "none",
                userSelect: "none",
            }}
        />
    );
};
