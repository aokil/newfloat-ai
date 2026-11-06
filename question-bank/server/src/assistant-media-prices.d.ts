export type MediaKind='image'|'video';
export interface MediaPrice {
  readonly version:string;
  readonly modelId:string;
  readonly kind:MediaKind;
  readonly currency:'CNY';
  readonly pointsPerYuan:20;
  readonly multiplier:'1.4';
  readonly source:'coze_public'|'app_policy';
  readonly sourceUrl:string;
  readonly unit:'image'|'1000_output_tokens';
  readonly rates:Readonly<{image?:string;audio?:string;silent?:string}>;
  /** Image: Lite per image = 1×. Video: 1.5 Pro audio per 1000 output tokens = 1×. */
  readonly displayMultiplier:string;
  readonly displayUnitPrice:string;
  readonly description:string;
  readonly derivedMultiplier?:3;
}
export interface MediaEffectiveParameters {
  prompt?:string;
  size?:string;
  count?:number;
  watermark?:boolean;
  resolution?:'480p'|'720p'|'1080p';
  ratio?:'16:9'|'4:3'|'1:1'|'3:4'|'9:16'|'21:9'|'adaptive';
  duration?:number;
  generate_audio?:boolean;
  reference_mode?:'first_frame'|'first_last_frame'|'reference_images';
}
export type MediaUsage={generatedImages:number}|{completionTokens:number};
export interface MediaQuote {
  amountNanos:string;
  /** Centipoints, rounded upward for reservation only. */
  units:number;
  estimated:boolean;
  guaranteedUpperBound:boolean;
  basis:{generatedImages:number}|{completionTokens:number;width:number;height:number;fps:24;duration:number;adaptive:boolean;sourceUrl:string;referenceModelId:string};
  description:string;
}
export function mediaPricing(modelId:unknown,kind:unknown):MediaPrice;
export function mediaEffectiveParameters(price:MediaPrice,params:unknown,references?:unknown[]):MediaEffectiveParameters;
export function mediaQuote(price:MediaPrice,effectiveParams:MediaEffectiveParameters):MediaQuote;
export function mediaUsage(raw:unknown,kind:MediaKind):MediaUsage;
export function mediaCost(price:MediaPrice,usage:unknown,effectiveParams:MediaEffectiveParameters):{
  nanos:bigint;
  rates:{image?:string;audio?:string;silent?:string;selected:'image'|'audio'|'silent'};
};
