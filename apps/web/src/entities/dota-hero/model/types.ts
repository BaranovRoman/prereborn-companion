import type { DotaHeroAttribute } from "./attributes";

export interface DotaHero {
    id: number;
    name: string;
    localizedName: string;
    imageUrl: string;
    videoUrl: string;
    attribute: DotaHeroAttribute;
}
