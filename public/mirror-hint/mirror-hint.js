(function () {
  'use strict';

  var origin = (document.querySelector('meta[name="mirror-origin"]') || {}).content || '';
  var base = (document.querySelector('meta[name="mirror-base"]') || {}).content || '/';

  function originPath() {
    var p = location.pathname;
    if (base && base !== '/' && p.indexOf(base) === 0) {
      p = p.slice(base.length - 1);
    }
    return origin + p;
  }

  function toast(msg, href) {
    var old = document.querySelector('.mh-toast');
    if (old) old.remove();
    var t = document.createElement('div');
    t.className = 'mh-toast';
    t.innerHTML = '<span></span>';
    t.firstChild.textContent = msg;
    if (href) {
      var a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '原站 ↗';
      t.appendChild(a);
    }
    document.body.appendChild(t);
    requestAnimationFrame(function () {
      t.classList.add('show');
    });
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () {
        t.remove();
      }, 250);
    }, 3600);
  }

  function replaceComments() {
    document.querySelectorAll('[id^="comment-content-"]').forEach(function (box) {
      var card = document.createElement('div');
      card.className = 'mh-comment-card';
      card.innerHTML =
        '<div>本站为静态镜像，评论请到原站查看。</div>' +
        '<a class="mh-btn" href="' + originPath() + '#comments" target="_blank" rel="noopener">前往原站查看评论 ↗</a>';
      box.parentNode.replaceChild(card, box);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', replaceComments);
  } else {
    replaceComments();
  }

  var PATTERN = /search|upvote|share|music|comment/i;
  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[id],[class]') : null;
    if (!el) return;
    if (el.tagName === 'A' && el.getAttribute('href')) return;
    var probe = ((el.id || '') + ' ' + (el.className || '')).toLowerCase();
    if (PATTERN.test(probe)) {
      e.preventDefault();
      toast('该功能在静态镜像中不可用，请到原站体验', origin);
    }
  });

  document.addEventListener('submit', function (e) {
    e.preventDefault();
    toast('表单功能在静态镜像中不可用，请到原站操作', origin);
  });

  function badge() {
    var b = document.createElement('div');
    b.className = 'mh-badge';
    b.innerHTML =
      '<span>静态镜像 · 完整功能请访问</span>' +
      '<a href="' + origin + '" target="_blank" rel="noopener">原站 ↗</a>' +
      '<button class="mh-close" aria-label="关闭">×</button>';
    b.querySelector('.mh-close').addEventListener('click', function () {
      b.classList.add('hide');
    });
    document.body.appendChild(b);
    setTimeout(function () {
      b.classList.add('hide');
    }, 8000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', badge);
  } else {
    badge();
  }
})();
