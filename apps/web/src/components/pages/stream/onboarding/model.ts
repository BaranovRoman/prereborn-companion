export interface OnboardingReadiness { companionOnline:boolean; gsiReceived:boolean; obsConfirmed:boolean }
export const onboardingProgress=(state:OnboardingReadiness):number=>[true,state.companionOnline,state.gsiReceived,state.obsConfirmed].filter(Boolean).length;
export const canCompleteOnboarding=(state:OnboardingReadiness):boolean=>state.companionOnline&&state.gsiReceived&&state.obsConfirmed;
export const onboardingStorageKey=(userId:string):string=>`prereborn:onboarding:obs-confirmed:${userId}`;
