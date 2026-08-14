import { defineConfig } from 'astro/config';

// GitHub Pages 项目站点基路径；若以后配置自定义域名，改为 '/' 或对应路径。
export default defineConfig({
  site: 'https://redrockteam.github.io',
  base: '/RedRockBlog',
  output: 'static',
});
